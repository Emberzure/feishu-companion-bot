// 飞书传送层：把飞书来的消息喂给核心，把核心写的话发回飞书。
// 换平台只要重写这个文件，其他都不用动。
//
// 用飞书官方的「长连接」模式（WSClient）：机器主动连出去，
// 不需要公网 IP、域名、端口映射 —— 在家用宽带上这是唯一可行的方式。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';

import { LLM } from './llm.mjs';
import { Memory } from './memory.mjs';
import { createSummarizer } from './summarize.mjs';
import { createRetriever } from './recall.mjs';
import {
  loadEnvFile, loadPersona, sendBubbles, oneLine,
} from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// ---------------------------------------------------------------- 配置

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const CFG = {
  appId: env.FEISHU_APP_ID || '',
  appSecret: env.FEISHU_APP_SECRET || '',
  apiKey: env.DEEPSEEK_API_KEY || '',
  ownerOpenId: env.OWNER_OPEN_ID || '',   // 留空则自动认领第一个跟机器人说话的人
  // 人设文件。默认读项目根目录的 persona.md，也可以用 PERSONA_PATH 指到别处。
  personaPath: env.PERSONA_PATH || path.join(ROOT, 'persona.md'),

  proactiveAfterHours: num(env.PROACTIVE_AFTER_HOURS, 4),
  proactiveDailyCap: num(env.PROACTIVE_DAILY_CAP, 3),
  quietFrom: num(env.QUIET_FROM, 1),
  quietTo: num(env.QUIET_TO, 8),

  // 每次回复前要不要调一次「记忆检索员」。
  // 开着：绕弯的说法也能匹配上。代价是开口前多等 1~2 秒（这个调用挡在前面）。
  // 关了：只走标签匹配，免费不延迟。觉得回得慢就在 .env 里写 RECALL_LLM=0。
  recallLLM: env.RECALL_LLM !== '0',
};

// 主人是谁：飞书用 open_id 标识用户（一串 ou_ 开头的编码）。
// 第一次有人跟机器人说话时把他记下来，之后只理这个人。
const OWNER_FILE = path.join(ROOT, 'data', 'owner.json');

function loadOwner() {
  if (CFG.ownerOpenId) return CFG.ownerOpenId;
  try { return JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')).openId || ''; } catch { return ''; }
}

function saveOwner(openId) {
  fs.mkdirSync(path.dirname(OWNER_FILE), { recursive: true });
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ openId, at: Date.now() }, null, 2));
}

// ---------------------------------------------------------------- 工具

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...a);

/** 飞书的消息 content 是一段 JSON 字符串，文本消息长这样：{"text":"你好"} */
function extractText(message) {
  if (message?.message_type !== 'text') return '';
  try {
    return (JSON.parse(message.content)?.text ?? '').trim();
  } catch { return ''; }
}

const inQuietHours = () => {
  const h = new Date().getHours();
  const { quietFrom: f, quietTo: t } = CFG;
  return f <= t ? h >= f && h < t : h >= f || h < t;
};

// ---------------------------------------------------------------- 启动检查

if (!CFG.appId || !CFG.appSecret) {
  console.error('✗ 缺少飞书凭证。先跑：./set-feishu-secret');
  process.exit(1);
}
if (!CFG.apiKey) {
  console.error('✗ 缺少 DEEPSEEK_API_KEY（.env 里）');
  process.exit(1);
}

// persona.md 就是完整的系统提示，不另外套一层说话风格。
const persona = loadPersona(CFG.personaPath);
const llm = new LLM({ apiKey: CFG.apiKey, system: persona });
const memory = new Memory(path.join(ROOT, 'data'));
// 这两个用的是另外的系统提示（整理员 / 检索员），不是角色人设 ——
// 拿角色人设去总结记忆，它会把记忆写成抒情文。
const summarize = createSummarizer({ apiKey: CFG.apiKey });
const retrieve = createRetriever({ apiKey: CFG.apiKey });

const client = new Lark.Client({ appId: CFG.appId, appSecret: CFG.appSecret });

// ---------------------------------------------------------------- 发消息

/** 给主人发一条纯文本。飞书单聊用 open_id 定位收件人。 */
async function sendToOwner(text) {
  const openId = loadOwner();
  if (!openId) throw new Error('还不知道主人是谁（没人跟机器人说过话）');
  const res = await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  if (res.code !== 0) throw new Error(`飞书发送失败 code=${res.code} ${res.msg}`);
  return res;
}

// ---------------------------------------------------------------- 回复

const busy = new Set();

// 同一句话会连着进来两三遍（手滑发重、飞书重投事件）。
// 不拦的话它会照着同一句答好几次，越答越乱。25 秒内算重复。
const DEDUP_WINDOW_MS = 25_000;
const lastSaid = new Map();   // sessionKey -> { text, at }

function isDuplicate(key, text) {
  const now = Date.now();
  const prev = lastSaid.get(key);
  lastSaid.set(key, { text, at: now });
  return !!prev && prev.text === text && now - prev.at < DEDUP_WINDOW_MS;
}

/**
 * 攒够一批旧对话就浓缩进长期记忆。
 * 顺序要紧：先"借出来"总结，成功了才归档。失败的话这批原样留着下次再试。
 */
async function maybeSummarize(sessionKey) {
  const job = memory.takeForSummary(sessionKey);
  if (!job) return;
  try {
    const { facts, episodes } = await summarize({ previous: job.previous, messages: job.messages });
    memory.applySummary(sessionKey, { facts, episodes, lastId: job.lastId });
    log(`[记忆] 已更新：${job.count} 条旧对话 → 事实 ${facts.length} 条、`
      + `新想起的事 ${episodes.length} 件（旧对话已归档，没删）`);
  } catch (e) {
    // 解析失败 / 网络断了 —— 这批消息一条都不会归档，下次原样再总结一遍
    log(`✗ 记忆总结失败（这 ${job.count} 条先留着，下次再试）：${e.message}`);
  }
}

/**
 * 他这句话戳到了哪几件旧事。
 * 先按标签粗筛（免费），再让检索员精挑（一次模型调用）。
 *
 * 出错只是"这次没想起什么"，绝不能挡住回复 —— 所有异常都在这里吞掉。
 */
async function rememberThings(sessionKey, text) {
  try {
    const candidates = memory.recall(sessionKey, text);
    if (!candidates.length) return [];

    if (!CFG.recallLLM) return candidates.slice(0, 2);   // 只用标签匹配

    const ids = await retrieve({ text, candidates });
    return candidates.filter((c) => ids.includes(c.id));
  } catch (e) {
    log(`· 记忆检索失败（这次不带旧事）：${e.message}`);
    return [];
  }
}

async function reply(sessionKey, text) {
  if (busy.has(sessionKey)) {
    log(`… ${sessionKey} 还在回复中，这条先跳过`);
    return;
  }
  busy.add(sessionKey);
  try {
    memory.append(sessionKey, 'user', text);

    // 两层记忆走两条路：事实每轮都带（一直"知道"），旧事被戳到才进（"想起来"）
    const recall = await rememberThings(sessionKey, text);
    const answer = await llm.chat(memory.context(sessionKey), {
      memory: memory.getMemory(sessionKey),
      recall,
    });
    if (recall.length) {
      memory.markRecalled(recall.map((e) => e.id));   // 记一笔，免得反复提同一件事
      log(`[想起] ${recall.map((e) => e.what.slice(0, 14)).join(' / ')}`);
    }

    memory.append(sessionKey, 'assistant', answer);
    await sendBubbles(sendToOwner, answer);
    log(`→ ${oneLine(answer)}`);
  } catch (e) {
    log(`✗ 回复失败：${e.message}`);
  } finally {
    busy.delete(sessionKey);
  }
  // 总结放最后、且不 await —— 它是后台活儿，别挡着回下一条消息
  maybeSummarize(sessionKey).catch(() => {});
}

// ---------------------------------------------------------------- 收消息
// 订阅「接收消息」事件。长连接模式下飞书把消息推到回调里，不用开端口、不用填 URL。

const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const message = data?.message;
    const sender = data?.sender;
    if (!message || !sender) return;

    // 机器人自己发的消息也会回来，忽略
    if (sender.sender_type === 'app' || sender.sender_type === 'bot') return;

    const openId = sender.sender_id?.open_id || '';
    const text = extractText(message);
    if (!openId || !text) return;

    // 认主人：只在还没认领时记一次
    let owner = loadOwner();
    if (!owner) {
      saveOwner(openId);
      owner = openId;
      console.log('');
      log('[主人] 已认领');
      log(`   open_id = ${openId}`);
      log('   （已存到 data/owner.json。想换人就把这个文件删掉，或重启一次）');
      console.log('');
    }

    if (openId !== owner) {
      log(`· 忽略了非主人的消息（来自 ${openId.slice(0, 12)}…）`);
      return;
    }

    const key = `feishu-${openId}`;
    if (isDuplicate(key, text)) {
      log(`· 重复消息，跳过（${oneLine(text, 20)}）`);
      return;
    }

    log(`← ${oneLine(text, 60)}`);
    await reply(key, text);
  },
});

// ---------------------------------------------------------------- 主动开口
//
// 四个前置条件，全部满足才开口。四条是同时成立的 —— 单独放宽其中任何一条，
// 它都会变成骚扰。
//   1. 上一条主动消息他还没回 → 不追发（最重要的一条）
//   2. 静默够久（默认 4 小时）
//   3. 免打扰时段不发（默认 1:00–8:00）
//   4. 每天有上限（默认 3 条）

const PROACTIVE_HINT = fs.readFileSync(new URL('./prompts/proactive.md', import.meta.url), 'utf8').trim();

async function tickProactive() {
  const owner = loadOwner();
  if (!owner) return;
  if (inQuietHours()) return;

  const key = `feishu-${owner}`;
  const data = memory.load(key);

  if (!data.lastUserAt) return;                  // 他还没说过话，别突然冒出来
  if (data.proactivePending) return;             // 上一条主动的还没回，不追
  if (busy.has(key)) return;

  const sinceUser = (Date.now() - data.lastUserAt) / 3_600_000;
  const sinceBot = (Date.now() - (data.lastBotAt || data.lastUserAt)) / 3_600_000;
  if (sinceUser < CFG.proactiveAfterHours || sinceBot < 1) return;

  const today = new Date().toISOString().slice(0, 10);
  const usedToday = data.proactiveDay === today ? data.proactiveToday : 0;
  if (usedToday >= CFG.proactiveDailyCap) return;

  busy.add(key);
  try {
    // 故意不做记忆检索：自己翻旧账出来提，跟"被戳到才想起"是两回事，
    // 情绪低谷那类主动翻一次可能就是伤。他提了才接。
    const answer = await llm.chat(memory.context(key), {
      hint: PROACTIVE_HINT,
      memory: memory.getMemory(key),
    });
    memory.markProactive(key);
    memory.append(key, 'assistant', answer);
    await sendBubbles(sendToOwner, answer);
    log(`[主动] ${oneLine(answer)}`);
  } catch (e) {
    log(`✗ 主动发言失败：${e.message}`);
  } finally {
    busy.delete(key);
  }
}

// ---------------------------------------------------------------- 起飞

log('[启动] bot 启动（飞书）');
log(`   App ID: ${CFG.appId}`);
log(`   主人: ${loadOwner() || '（还没认领 —— 你先给机器人发一句话）'}`);
log('   正在建立长连接…');

const wsClient = new Lark.WSClient({ appId: CFG.appId, appSecret: CFG.appSecret });
wsClient.start({ eventDispatcher: dispatcher });

setInterval(tickProactive, 10 * 60 * 1000); // 每 10 分钟看一次要不要主动开口
