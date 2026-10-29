// 飞书传送层
//
// 只干两件事：把飞书来的消息喂给核心，把核心写的话发回飞书。
// 人设、说话风格、记忆、调模型全在 core.mjs / llm.mjs / memory.mjs 里，那边跟平台无关。
//
// 用的是飞书官方的「长连接」模式（WSClient）：
//   你的电脑主动连出去，不需要公网 IP、不需要域名、不需要端口映射。
//   这对家用宽带是唯一可行的方式 —— Webhook 模式要求飞书能反向连到你，做不到。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';

import { LLM } from './llm.mjs';
import { Memory } from './memory.mjs';
import { localDay } from './clock.mjs';
import { createSummarizer } from './summarize.mjs';
import { createRetriever } from './recall.mjs';
import { createReflector } from './reflect.mjs';
import { isDistress } from './life.mjs';
import { createTTS } from './tts.mjs';
import {
  parseVoiceMarker, voicePreference, looksUnspeakable, voiceInstruction, speakable,
} from './voice.mjs';
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

  // 主动发言不再是「静默 4 小时、每天 3 条」的打卡。
  // 现在每天先随机抽一个额度（0 到 proactiveDailyCap），再随机挑一个想他的时刻；
  // 半夜也可以发 —— 她只是醒着，不是特意吵人。
  proactiveAfterHours: num(env.PROACTIVE_AFTER_HOURS, 2),
  proactiveDailyCap: num(env.PROACTIVE_DAILY_CAP, 5),
  proactiveMinGapH: num(env.PROACTIVE_MIN_GAP_HOURS, 0.75),
  quietFrom: num(env.QUIET_FROM, 1),
  quietTo: num(env.QUIET_TO, 8),

  // 每次回复前，要不要调一次「记忆检索员」来挑该想起哪几件旧事。
  //
  // 开着：想起得更准（"又去老地方了"能想起常去的那家店那条）。代价是她说第一句话前
  //       多等 1~2 秒 —— 这个调用挡在她开口前面。
  // 关了：只走标签匹配。免费、不延迟，但绕弯的说法匹配不上。
  //
  // 觉得她回得慢了就把这个设成 0（.env 里写 RECALL_LLM=0）。
  recallLLM: env.RECALL_LLM !== '0',

  // 她自己的生活：此刻在做什么、今天什么天气、每天一篇自己的日记。
  //   off   —— 完全关闭，提示词里不出现【你自己的生活】
  //   light —— 默认。活动/天气本地生成，日记一天最多两篇
  //   full  —— 现在和 light 一样，留给以后的项目/事件流
  life: (env.LIFE || 'light').toLowerCase(),

  // 语音条。默认 auto：她自己决定，多数时候打字。
  //   auto   —— 模型在回复开头写 <<v>> 才发语音（默认）
  //   off    —— 完全不发语音（他明确说"用语音说"时仍然会发）
  //   always —— 每条都发语音（只建议临时调试用）
  dashscopeKey: env.DASHSCOPE_API_KEY || '',
  ttsModel: env.TTS_MODEL || 'qwen-audio-3.1-tts-flash',
  ttsRate: num(env.TTS_RATE, 1.2),
  ttsVoiceId: env.QWEN_TTS_VOICE_ID || '',
  voiceMode: (env.VOICE_MODE || 'auto').toLowerCase(),
  voiceMaxChars: num(env.VOICE_MAX_CHARS, 80),
  // 0 = 不限条数。仍然计数（日志/voice-state.json 里能看到今天说了几条），只是不再拦。
  voiceDailyCap: num(env.VOICE_DAILY_CAP, 0),
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

// 人设文件现在就是完整的系统提示 —— 说话规则已经并进它的第三节了，
// 不再在外面套一层 CHAT_STYLE。（见 core.mjs 里那段说明）
const persona = loadPersona(CFG.personaPath);
const llm = new LLM({ apiKey: CFG.apiKey, system: persona });
const memory = new Memory(path.join(ROOT, 'data'));
// 下面两个用的都是另一个"人"（记忆整理员 / 记忆检索员），不是角色本人。
// 详见 summarize.mjs 和 recall.mjs —— 拿她的人格去干这两件事会把记忆写成抒情文。
const summarize = createSummarizer({ apiKey: CFG.apiKey });
const retrieve = createRetriever({ apiKey: CFG.apiKey });
// 日记也是另一个人写的：低温柔，不拿角色聊天的人格 ——
// 用她的语气写日记，会写成一段发给他的话。
const reflect = CFG.life === 'off' ? null : createReflector({ apiKey: CFG.apiKey });
const reflecting = new Set();

const client = new Lark.Client({ appId: CFG.appId, appSecret: CFG.appSecret });

// 语音合成。没有 key 或还没创建音色时 available=false，聊天照常走文字。
const tts = createTTS({
  apiKey: CFG.dashscopeKey,
  model: CFG.ttsModel,
  voiceId: CFG.ttsVoiceId,
  rate: CFG.ttsRate,
  tmpDir: path.join(ROOT, 'data', 'tmp'),
});

// 每天发了几条语音。存成一个小文件，重启不清零 —— 否则改一次代码
// 就能把当天的额度刷掉。按本地日算，和主动发言的上限同一个口径。
const VOICE_STATE_FILE = path.join(ROOT, 'data', 'voice-state.json');

function voiceUsedToday() {
  try {
    const s = JSON.parse(fs.readFileSync(VOICE_STATE_FILE, 'utf8'));
    return s.day === localDay() ? Number(s.count) || 0 : 0;
  } catch { return 0; }
}

function markVoiceUsed() {
  const count = voiceUsedToday() + 1;
  try {
    fs.mkdirSync(path.dirname(VOICE_STATE_FILE), { recursive: true });
    fs.writeFileSync(VOICE_STATE_FILE, JSON.stringify({ day: localDay(), count }, null, 2));
  } catch (e) {
    log(`· 语音额度写入失败（不影响发送）：${e.message}`);
  }
  return count;
}

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

/**
 * 把飞书 SDK 抛出来的 axios 错误翻译成人话。
 *
 * SDK 只留一句 "Request failed with status code 400"，真正的原因
 * （比如缺 im:resource:upload 权限）在 response.data.msg 里。
 * 不把它带出来，日志里就只能看见 400，根本不知道要去开放平台开权限。
 */
function larkError(action, e) {
  const d = e?.response?.data;
  const detail = d ? `${d.code ?? ''} ${d.msg ?? ''}`.trim() : e?.message;
  return new Error(`${action}：${detail || '未知错误'}`);
}

/**
 * 给主人发一条语音。
 *
 * 飞书不替你转格式：必须是 Opus。所以先在 tts.mjs 里合成 wav 并转成
 * 16k 单声道 Opus，再上传拿 file_key，最后用 msg_type=audio 发出去。
 * 上传接口返回的是内层 data（{file_key}），不是 message 那种完整信封 ——
 * 两种形状都兜一下，SDK 版本换过一次。
 */
async function sendVoice(text) {
  const openId = loadOwner();
  if (!openId) throw new Error('还不知道主人是谁（没人跟机器人说过话）');

  const { buffer, durationMs, cleanup } = await tts.synthesize(text);
  try {
    let up;
    try {
      up = await client.im.file.create({
        data: {
          file_type: 'opus',
          file_name: 'voice.opus',
          duration: durationMs,
          file: buffer,
        },
      });
    } catch (e) {
      throw larkError('上传语音失败', e);
    }
    const fileKey = up?.file_key || up?.data?.file_key;
    if (!fileKey) throw new Error(`上传语音失败：${JSON.stringify(up).slice(0, 300)}`);

    let res;
    try {
      res = await client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'audio',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });
    } catch (e) {
      throw larkError('发送语音失败', e);
    }
    if (res.code !== 0) throw new Error(`飞书发送语音失败 code=${res.code} ${res.msg}`);
    return { fileKey, durationMs };
  } finally {
    cleanup?.();
  }
}

/** 只在语音真的可用时，才把「这条怎么发」塞进提示词。 */
function voiceHint(force) {
  if (!tts.available) return '';
  if (CFG.voiceMode === 'off' && force !== 'voice') return '';
  return voiceInstruction({ maxChars: CFG.voiceMaxChars, force });
}

/**
 * 这条回复到底发语音还是打字。
 *
 * 顺序是有意的：明确的「打字」最先，然后是配置、长度/格式、免打扰、额度，
 * 最后才看模型有没有写 <<v>>。任何一条不满足都退回文字 ——
 * 宁可少一条语音，也不能让语音链路把她的话吞掉。
 */
function shouldSpeak(text, mark, force) {
  if (force === 'text') return false;
  if (!tts.available) return false;
  if (CFG.voiceMode === 'off' && force !== 'voice') return false;
  if (looksUnspeakable(text, CFG.voiceMaxChars)) return false;

  // 他明确要语音：不卡免打扰，也不卡当天额度 —— 那是他主动要的。
  if (force === 'voice') return true;

  if (inQuietHours()) return false;
  if (CFG.voiceDailyCap > 0 && voiceUsedToday() >= CFG.voiceDailyCap) return false;
  if (CFG.voiceMode === 'always') return true;
  return mark === 'v';
}

/**
 * 把模型的话送出去：可能是语音，也可能是文字。
 *
 * 不管走哪条，返回的 text 都是剥掉 <<v>> 之后的正文 ——
 * 上层要拿它写进记忆，不能把标记也存进去。
 */
async function deliverAnswer(answer, { force = null, prefix = '→' } = {}) {
  const { text, mark } = parseVoiceMarker(answer);
  if (!text) return { text: '', voice: false };

  if (shouldSpeak(text, mark, force)) {
    try {
      const { durationMs } = await sendVoice(speakable(text));
      const used = markVoiceUsed();
      const quota = CFG.voiceDailyCap > 0 ? `今天第 ${used}/${CFG.voiceDailyCap} 条` : `今天第 ${used} 条，不限`;
      log(`🔊 语音 ${Math.round(durationMs / 1000)}s（${quota}）：${oneLine(text)}`);
      return { text, voice: true };
    } catch (e) {
      // 合成超时、上传失败、格式不对 —— 都退回文字。他必须收到回复。
      log(`✗ 语音失败，改发文字：${e.message}`);
    }
  }

  await sendBubbles(sendToOwner, text);
  log(`${prefix} ${oneLine(text)}`);
  return { text, voice: false };
}

// ---------------------------------------------------------------- 回复

const busy = new Set();

// 同一句话会连着进来两遍 —— 手机上手滑发重、或者飞书把事件重投一次。
// 不拦的话她会照着同一句回答两三次，而且越答越乱。25 秒内同样的话第二遍就当重复。
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
 *
 * 注意顺序：takeForSummary 只是把要总结的消息"借出来"，不删。
 * 只有总结成功了才 applySummary 把它们删掉 ——
 * 万一模型调用失败，这批消息原样留着，下次再试。宁可多留，不能丢。
 */
async function maybeSummarize(sessionKey) {
  const job = memory.takeForSummary(sessionKey);
  if (!job) return;
  try {
    const {
      facts, episodes, threads, self,
    } = await summarize({
      previous: job.previous, messages: job.messages, threads: memory.openThreads(sessionKey),
    });
    memory.applySummary(sessionKey, { facts, episodes, threads, self, lastId: job.lastId });
    log(`🧠 记忆已更新：${job.count} 条旧对话 → 事实 +${facts.add.length}/`
      + `改${facts.update.length}/废${facts.remove.length}、`
      + `新想起的事 ${episodes.length} 件`
      + `（话头 +${threads.add.length}/了结${threads.done.length}`
      + `${self ? '，她自己的状态已更新' : ''}）（旧对话已归档，没删）`);
    // 整份重写是我们要离开的那条老路（输出会随事实条数一起涨，迟早撞 max_tokens）。
    // 兼容是留着防死锁，但得让它可见 —— 老是出现就说明提示词又没被听进去。
    if (facts.legacy) log('· ⚠ 整理员这次按旧格式输出了整份清单（已兼容处理）');
  } catch (e) {
    // 解析失败 / 网络断了 —— 这批消息一条都不会归档，下次原样再总结一遍
    log(`✗ 记忆总结失败（这 ${job.count} 条先留着，下次再试）：${e.message}`);
  }
}

/**
 * 她自己的日记。后台写，不挡回复。
 *
 * 门槛在 memory.diaryJob 里：同一天最多两篇、至少聊了几轮、傍晚以后才容易触发。
 * 写失败就当今天没写 —— 日记是底色，不能因为它把回复拖垮。
 */
async function maybeReflect(sessionKey, now = Date.now()) {
  if (!reflect || reflecting.has(sessionKey)) return null;
  const job = memory.diaryJob(sessionKey, now);
  if (!job) return null;

  reflecting.add(sessionKey);
  try {
    const diary = await reflect(job);
    const saved = memory.saveDiary(sessionKey, { day: job.day, at: now, ...diary });
    if (saved) {
      log(`📔 她自己写了一篇（${diary.mood}${diary.shareable ? '，可以讲' : '，只给自己看'}）：`
        + oneLine(diary.thought, 60));
    }
    return saved;
  } catch (e) {
    log(`· 日记没写成（不影响回复）：${e.message}`);
    return null;
  } finally {
    reflecting.delete(sessionKey);
  }
}

/**
 * 他现在这句话，让她想起哪几件旧事。
 *
 * 两级：先按标签粗筛（免费），再让记忆检索员精挑（一次模型调用）。
 * 检索员够不着敏感条目 —— 那类在 memory.recall() 就被挡住了，不进候选。
 *
 * **这一层永远不能挡住她开口。** 任何环节出错都只是"这次没想起什么"，
 * 而不是不回消息。
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
    // 时间要在 append **之前**读。append 会把 last_user_at 刷成"现在"，
    // 之后再来读，那句"他上一次说话是…"就永远是"刚刚"，等于没说。
    const before = memory.load(sessionKey);
    memory.append(sessionKey, 'user', text);

    // 先看她该想起什么，再开口。两层记忆走两条路：
    //   memory  —— 关于他的事实，每轮都带（他一直"知道"这些）
    //   recall  —— 被他这句话戳到的旧事（她"想起来"这些）
    const recall = await rememberThings(sessionKey, text);
    const force = voicePreference(text);
    // 她自己的日子：此刻在做什么、今天什么天气、昨晚写下的那篇。
    // distress 只影响提示词里的一句话 —— 她可以承认自己也难受，
    // 但不会因此不回、不接。
    const life = CFG.life === 'off' ? null : {
      ...memory.getLife(sessionKey),
      distress: isDistress(text),
    };
    const answer = await llm.chat(memory.context(sessionKey), {
      memory: memory.getMemory(sessionKey),
      selfState: memory.getSelfState(sessionKey),
      life,
      recall,
      times: {
        now: Date.now(), lastUserAt: before.lastUserAt, lastBotAt: before.lastBotAt,
      },
      voice: voiceHint(force),
    });
    if (recall.length) {
      memory.markRecalled(recall.map((e) => e.id));   // 记一笔，免得反复提同一件事
      log(`💭 想起：${recall.map((e) => e.what.slice(0, 14)).join(' / ')}`);
    }

    // 先剥掉 <<v>> 再进历史 —— 不能让她在上下文里看见这个标记，
    // 不然下一次她会照着学，甚至把它当正文说出来。
    const { text: said } = parseVoiceMarker(answer);
    memory.append(sessionKey, 'assistant', said || answer);
    await deliverAnswer(answer, { force });
  } catch (e) {
    log(`✗ 回复失败：${e.message}`);
  } finally {
    busy.delete(sessionKey);
  }
  // 总结和日记都放最后、且不 await —— 后台活儿，别挡着回下一条消息
  maybeSummarize(sessionKey).catch(() => {});
  maybeReflect(sessionKey).catch(() => {});
}

// ---------------------------------------------------------------- 收消息
//
// 订阅「接收消息」事件。长连接模式下，飞书把消息推到这个回调里，
// 不用开端口、不用填 URL。

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
      log('🎀 认下主人了');
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
// 目标不是「定时汇报」，是像一个真的会走神、会突然想起你的人：
//   · 每天先随机抽一个额度（0 到 PROACTIVE_DAILY_CAP），有的日子一条都没有；
//   · 到没到「想他」的时刻也是随机的，不是固定间隔；
//   · 半夜也可以发 —— 她只是醒着，不是特意吵人；
//   · 真没什么想说的，可以回 <<skip>>，不为了发而发；
//   · 上一条没回，最多再追一次，间隔拉长；追过就停，不连环轰炸。

const PROACTIVE_HINT = [
  '（现在是系统提示：上面那块【现在】写着今天几号、现在几点、他上一次说话是什么时候。',
  '你不是在等指令。你只是忽然想起他，想跟他说句话。',
  '可以很短：说一件你此刻正在做的小事、你忽然想到的一件事、叫他一声，都行。',
  '尽量别说"在吗""吃了吗"这种谁都能发的句子 —— 你今天有自己的日子。',
  '也可以只是关心一句，或者什么正事都没有。',
  '半夜也可以发 —— 你只是醒着，不是特意挑这个点吵他。',
  '开口之前先看一眼那个时间：深夜就别默认他醒着，天刚亮就别默认他睡好了、吃过了。',
  '他昨晚几点还在说话，那上面有。',
  '但如果你这会儿其实没什么想说的，就只回 <<skip>>，不要为了发而发。',
  '不要问「你怎么了」这种逼他交代的话。）',
].join('\n');

/**
 * 他还惦记着的事 —— 塞进主动提示。
 *
 * 给的是"有话头"，不是"必须问这个"：到时候他可能早说过了，或者压根不想提。
 * 所以明说了问过就当没这回事，别追问、别邀功（"我还记着呢"那种最假）。
 */
function threadHint(t) {
  return `（顺带一提：你还记着一件事 —— ${t.what}。`
    + '要是这会儿顺得上，就问一句他这事儿怎么样了；一句话就够。'
    + '他要是已经说过了、或者明显不想聊，就当没这回事，别追问，也别说"我一直记着"。）';
}

const PROACTIVE_STATE_FILE = path.join(ROOT, 'data', 'proactive-state.json');

const rand = (min, max) => min + Math.random() * (max - min);

function loadProactiveState(key) {
  try {
    const all = JSON.parse(fs.readFileSync(PROACTIVE_STATE_FILE, 'utf8'));
    return all[key] || {};
  } catch { return {}; }
}

function saveProactiveState(key, patch) {
  let all = {};
  try {
    const raw = JSON.parse(fs.readFileSync(PROACTIVE_STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') all = raw;
  } catch { /* 第一次写，没有就没有 */ }
  all[key] = { ...(all[key] || {}), ...patch };
  try {
    fs.mkdirSync(path.dirname(PROACTIVE_STATE_FILE), { recursive: true });
    fs.writeFileSync(PROACTIVE_STATE_FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    log(`· 主动发言状态写入失败（不影响这一轮）：${e.message}`);
  }
}

/**
 * 下一次「忽然想起他」的时刻。
 *
 * 没回过的上一条会让间隔拉长（4–12 小时），避免变成催促；
 * 平时大多数是 2–9 小时，偶尔一两个小时后又想起来了。
 */
function nextProactiveAt(unanswered = 0) {
  const hours = unanswered > 0
    ? rand(4, 12)
    : (Math.random() < 0.3 ? rand(0.75, 2) : rand(2, 9));
  return Date.now() + hours * 3_600_000;
}

async function tickProactive() {
  const owner = loadOwner();
  if (!owner) return;

  const key = `feishu-${owner}`;
  const data = memory.load(key);

  if (!data.lastUserAt) return;                  // 他还没说过话，别突然冒出来
  if (busy.has(key)) return;

  const today = localDay();   // 本地日，不是 UTC —— 见 clock.mjs 里的说明

  // 今天的额度每天重抽一次：可能 0，也可能到上限。有"一整天没想起他"才像人。
  let st = loadProactiveState(key);
  if (st.day !== today || !Number.isFinite(st.budget)) {
    st = {
      day: today,
      budget: Math.floor(Math.random() * (Math.max(0, CFG.proactiveDailyCap) + 1)),
      unanswered: data.proactivePending ? 1 : 0,
      nextAt: Date.now() + rand(1, 6) * 3_600_000,
    };
    saveProactiveState(key, st);
  }

  const usedToday = data.proactiveDay === today ? data.proactiveToday : 0;
  if (usedToday >= st.budget) return;

  // 上一条没回：允许最多追一次；追过就彻底停下，等他先开口。
  const unanswered = data.proactivePending ? Math.max(1, Number(st.unanswered) || 1) : 0;
  if (unanswered >= 2) return;
  if (unanswered === 0 && st.unanswered) {
    st.unanswered = 0;                            // 他回过了，重新开始计
    saveProactiveState(key, { unanswered: 0 });
  }

  const sinceUser = (Date.now() - data.lastUserAt) / 3_600_000;
  const sinceBot = (Date.now() - (data.lastBotAt || data.lastUserAt)) / 3_600_000;
  if (sinceUser < CFG.proactiveAfterHours || sinceBot < CFG.proactiveMinGapH) return;

  // 到没到她「想起他」的时刻，是随机的。没到就继续等，不重排。
  if (st.nextAt && Date.now() < Number(st.nextAt)) return;

  busy.add(key);
  try {
    // 主动开口前先看看今天有没有新日记要写 —— 她主动找人时，
    // 最好手里真有一件自己的事，而不是空着手问"在吗"。
    // 这里等它写完（一两秒），主动消息不怕慢这一点。
    if (CFG.life !== 'off') await maybeReflect(key);

    // 先把挂了太久的收掉，再挑一条该接上的。
    const expired = memory.expireThreads(key);
    if (expired) log(`· ${expired} 条话头放太久了，收摊`);

    // 只挑**到点了**或**本来没定日子**的 —— 他下周三才考试，今天不该问考得怎么样。
    const thread = memory.pickThread(key);

    // 这里**故意不做记忆检索** —— 她自己翻旧账出来提，跟"想起他"是两回事，
    // 尤其那些情绪低谷的事，主动翻一次可能就是伤。他提了才接。
    // （要开也行，把 rememberThings 的结果也传进来就是。先不开。）
    //
    // 但话头（threads）是可以主动提的：那是他自己说的、将来会发生的事 ——
    // 「你还记着他下周三要考试」正是用户要的"把某些话题主动进行下去"。
    const life = CFG.life === 'off' ? null : {
      ...memory.getLife(key),
      distress: false,
    };
    const answer = await llm.chat(memory.context(key), {
      hint: thread ? `${threadHint(thread)}\n\n${PROACTIVE_HINT}` : PROACTIVE_HINT,
      memory: memory.getMemory(key),
      selfState: memory.getSelfState(key),
      life,
      times: {
        now: Date.now(), lastUserAt: data.lastUserAt, lastBotAt: data.lastBotAt,
      },
      voice: voiceHint(null),
    });

    // 她也可以「这次没什么想说的」。不为了发而发，也是活人感的一部分。
    if (/^<<skip>>$/i.test(String(answer || '').trim())) {
      log('· 这次没什么想说的，先不发');
      saveProactiveState(key, { unanswered, nextAt: nextProactiveAt(unanswered) });
      return;
    }

    memory.markProactive(key);
    // 问过就不再念叨 —— 记住以"发出去了"为准，不是以"他回了"为准。
    // 万一这句没送出去也认了：宁可漏问一次，也不能天天追着同一件事问。
    if (thread) {
      memory.markThreadAsked(thread.id);
      log(`↗ 主动接上话头：${oneLine(thread.what, 30)}`);
    }
    memory.append(key, 'assistant', parseVoiceMarker(answer).text || answer);
    await deliverAnswer(answer, { prefix: '↗' });
    saveProactiveState(key, {
      unanswered: unanswered + 1,
      nextAt: nextProactiveAt(unanswered + 1),
      lastAt: Date.now(),
    });
  } catch (e) {
    log(`✗ 主动发言失败：${e.message}`);
  } finally {
    busy.delete(key);
  }
}

// ---------------------------------------------------------------- 起飞

log('🎀 bot 启动（飞书）');
log(`   App ID: ${CFG.appId}`);
log(`   主人: ${loadOwner() || '（还没认领 —— 你先给机器人发一句话）'}`);
log(tts.available
  ? `   语音: ${CFG.voiceMode}（音色 …${tts.voice.slice(-12)}，语速 ${tts.rate}×，`
    + `${CFG.voiceDailyCap > 0 ? `每天最多 ${CFG.voiceDailyCap} 条` : '不限条数'}，`
    + `超过 ${CFG.voiceMaxChars} 字或带链接/代码/清单时自动打字）`
  : `   语音: 未启用（${tts.reason}）`);
log(`   她自己的生活: ${CFG.life === 'off'
  ? '关闭'
  : '轻量（此刻 / 天气 / 日记，一天最多两篇）'}`);
log('   正在建立长连接…');

const wsClient = new Lark.WSClient({ appId: CFG.appId, appSecret: CFG.appSecret });
wsClient.start({ eventDispatcher: dispatcher });

// 检查的节奏也带点抖动（2–7 分钟），别让她的消息总落在整点、整十分。
function scheduleProactive() {
  const wait = rand(2, 7) * 60_000;
  setTimeout(async () => {
    try { await tickProactive(); } catch (e) { log(`✗ 主动检查失败：${e.message}`); }
    scheduleProactive();
  }, wait);
}
scheduleProactive();
