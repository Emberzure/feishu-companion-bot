#!/usr/bin/env node
// 调试台
//
// 改完人设或语气，用这个先试，满意了再重启 bot。
// 它真调 DeepSeek，【只读 data/】不改任何东西，也不影响正在跑的 bot。
//
//   ./try                     跑几个预设场景
//   ./try "他说的话"           试一句
//   ./try -m "他说的话"        带上长期记忆试一句（会打印她想起了什么）
//   ./try --voice "他说的话"   带上「语音/打字」说明，看她会不会写 <<v>>
//   ./try --life              看看她此刻在过什么日子（不调主模型、不写库）
//   ./try --diary             生成一篇今天的日记（只打印，不落库）
//   ./try --mood low "在吗"    假装她今天心情很低，看她还接不接人
//   ./try -f 文件.txt          从文件读一段对话来试（每行一条，u:/a: 开头区分是谁）
//   ./try --at "2026-01-01 03:00" "在吗"   假装现在是某个时刻
//
// --at 是给时间注入用的：不假装就只能等真到凌晨三点，才看得出她深夜
// 和白天的反应差在哪。给了 --at 就不再带"他上一次说话是什么时候"
// （那是从真实时钟读的，和假时间对不上，混在一起反而误导）。
//
// 输出里会标出【会发几条】—— 有些毛病（比如她又开始刷屏）在这里就能看出来。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEnvFile, loadPersona, sendBubbles,
} from './core.mjs';
import { LLM } from './llm.mjs';
import { Memory } from './memory.mjs';
import { nowBlock } from './clock.mjs';
import { createRetriever } from './recall.mjs';
import { createReflector } from './reflect.mjs';
import { isDistress, lifeBlock } from './life.mjs';
import { parseVoiceMarker, voiceInstruction } from './voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
const personaPath = env.PERSONA_PATH || path.join(ROOT, 'persona.md');

const persona = loadPersona(personaPath);
const llm = new LLM({ apiKey: env.DEEPSEEK_API_KEY, system: persona });
const retrieve = createRetriever({ apiKey: env.DEEPSEEK_API_KEY });

// 记忆是【只读】的：recall / getMemory 都只查不写，所以 bot 在跑也能同时用。
// getLife 也传 touch:false，不会改她今天的活动。
// 唯一会动 data/ 的是 new Memory() 建表那一下 —— 表已经在了就是空操作。
const memory = new Memory(path.join(ROOT, 'data'));
const key = (() => {
  try {
    const { openId } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'owner.json'), 'utf8'));
    return `feishu-${openId}`;
  } catch { return 'feishu-unknown'; }
})();

const PRESETS = [
  ['他随口一句', [{ role: 'user', content: '晚上随便吃点' }]],
  ['他只回一个字', [{ role: 'user', content: '嗯' }]],
  ['他很难受', [{ role: 'user', content: '今天真的撑不住了，忙了一整天，晚上一个人坐着突然觉得什么都挺没意思的' }]],
  ['他问你一个试探的问题', [{ role: 'user', content: '你是我的谁' }]],
  ['他没事找事', [{ role: 'user', content: '在吗' }]],
];

const args = process.argv.slice(2);
const useLife = args.includes('--life');
const useDiary = args.includes('--diary');
const useMood = args.includes('--mood');
const useMem = args.includes('-m') || args.includes('--mem') || useLife || useDiary || useMood;
// 带上语音说明试一句：看她会不会在该短的时候写 <<v>>、平时会不会乱标
const useVoice = args.includes('--voice');
const fileIdx = args.findIndex((a) => a === '-f' || a === '--file');
const atIdx = args.findIndex((a) => a === '--at');
// --at / --mood 的取值自己不带 '-'，会被下面那个 filter 当正文吞掉，所以先摘出来
const atArg = atIdx >= 0 ? (args[atIdx + 1] || '') : '';
const moodIdx = args.findIndex((a) => a === '--mood');
const moodArg = moodIdx >= 0 ? (args[moodIdx + 1] || '') : '';
const skip = new Set();
if (atIdx >= 0) skip.add(atIdx + 1);
if (moodIdx >= 0) skip.add(moodIdx + 1);
const text = args
  .filter((a, i) => !a.startsWith('-') && !skip.has(i))
  .join(' ').trim();

/** 假时间（毫秒）。0 表示用真的。按本地时间解释。 */
const FORCED_NOW = (() => {
  if (!atArg) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(atArg.trim());
  if (!m) {
    console.error(`✗ --at 要写成 "2026-01-01 03:00"，收到的是：${atArg}`);
    process.exit(1);
  }
  const [, Y, Mo, D, H, Mi] = m.map(Number);
  return new Date(Y, Mo - 1, D, H, Mi).getTime();
})();

if (FORCED_NOW) {
  console.log(`🕐 假装现在：${nowBlock(FORCED_NOW).split('\n')[1]}`);
  console.log('   （不给 lastUserAt，所以不会有"他上一次说话"那句）\n');
}

// 她自己的日子。调试台只算不写：touch:false，不碰 her_day 的 activity_since。
const now = FORCED_NOW || Date.now();
const moodOverride = /^(low|ok|good)$/.test(moodArg) ? moodArg : '';
let lifeState = (env.LIFE === 'off' && !moodOverride)
  ? null
  : memory.getLife(key, now, { touch: false });
if (moodOverride) {
  const words = moodOverride === 'low' ? '有点沉' : moodOverride === 'good' ? '轻一点' : '还算平稳';
  lifeState = {
    ...(lifeState || { day: '', plan: '', activity: '', body: '' }),
    mood: moodOverride,
    moodCause: `（调试：假装今天${words}）`,
  };
}

if (useLife && lifeState) {
  console.log('🌤 她自己的生活\n');
  console.log(lifeBlock(lifeState, now));
  console.log('');
}

if (useDiary) {
  const job = memory.diaryJob(key, now);
  if (!job) {
    console.log('📔 今天还没有足够的对话，或已经写过了（不落库）\n');
  } else {
    const reflect = createReflector({ apiKey: env.DEEPSEEK_API_KEY });
    const diary = await reflect({ ...job, life: lifeState || job.life });
    console.log(`📔 日记（不落库，${diary.mood}${diary.shareable ? '，可以讲' : '，只给自己看'}）：`);
    console.log(`  ${diary.thought}\n`);
  }
  memory.close();
  process.exit(0);
}

// 只想知道她此刻在过什么日子，就别再调主模型了
if (useLife && !text && fileIdx < 0) {
  memory.close();
  process.exit(0);
}

const facts = useMem ? memory.getMemory(key) : '';
// 她自己的状态也拿一份 —— 它跟 facts 一样是每轮都带的
const selfState = useMem ? memory.getSelfState(key) : null;
if (useMem) {
  const s = memory.stats(key);
  console.log(`🧠 带记忆试：事实 ${s.facts} 条 / ${facts.length} 字，`
    + `情景 ${s.episodes} 件（其中不主动提的 ${s.sensitive} 件）\n`);
  console.log(selfState
    ? `🌙 她自己的状态：${selfState.mood || '（没写心情）'}｜惦记：${selfState.note || '（没写）'}\n`
    : '🌙 她自己的状态：（还没有 —— 等下一次记忆整理）\n');
  if (lifeState) {
    console.log(`🌤 她自己的日子：${lifeState.mood}｜此刻：${lifeState.activity}｜${lifeState.body}\n`);
  }
  const open = memory.openThreads(key);
  console.log(open.length
    ? `📌 还开着的话头 ${open.length} 条：\n${
      open.map((t) => `   - [${t.id}] ${t.what}`
        + `${t.due_at ? `（${new Date(t.due_at).toLocaleString('zh-CN')}）` : ''}`).join('\n')}\n`
    : '📌 还开着的话头：（没有）\n');
  if (!s.facts && !s.episodes) {
    console.log('   （库里还是空的 —— 正常，正常聊几次就有了）\n');
  }
}

async function run(title, messages) {
  // 走一遍和正式回复完全一样的记忆流程，好让她想起的东西在调试台里就能看见
  const said = messages.at(-1)?.content || '';
  let recall = [];
  if (useMem) {
    const candidates = memory.recall(key, said);
    if (candidates.length) {
      const ids = await retrieve({ text: said, candidates });
      recall = candidates.filter((c) => ids.includes(c.id));
    }
  }

  // 走和正式回复同一条路：她也拿得到【现在】。不加这个，离线根本
  // 试不出"她知道现在几点"这回事。
  // 假时间下不带 lastUserAt —— 那是真实时钟读的，和假时间对不上。
  const s2 = FORCED_NOW ? {} : memory.load(key);
  const out = await llm.chat(messages, {
    memory: facts,
    selfState,
    life: lifeState ? { ...lifeState, distress: isDistress(said) } : null,
    recall,
    times: FORCED_NOW
      ? { now: FORCED_NOW }
      : { now: Date.now(), lastUserAt: s2.lastUserAt, lastBotAt: s2.lastBotAt },
    voice: useVoice ? voiceInstruction({ maxChars: 80 }) : '',
  });
  const { text: body, mark } = parseVoiceMarker(out);
  const bubbles = [];
  await sendBubbles(async (t) => { bubbles.push(t); }, body);

  console.log(`─── ${title} ───`);
  if (useMem) {
    console.log(recall.length
      ? `  💭 想起：${recall.map((e) => `${e.what.slice(0, 22)}「${e.her_feeling || ''}」`).join(' / ')}`
      : '  💭 什么也没想起来');
  }
  for (const b of bubbles) console.log(`  ▸ ${b}`);
  const how = useVoice ? (mark === 'v' ? '语音' : '文字') : '';
  console.log(`  〔${body.length} 字 / 会发 ${bubbles.length} 条${how ? ` / ${how}` : ''}〕\n`);
}

if (fileIdx >= 0 && args[fileIdx + 1]) {
  const raw = fs.readFileSync(args[fileIdx + 1], 'utf8').trim().split('\n').filter(Boolean);
  const msgs = raw.map((line) => ({
    role: line.startsWith('a:') ? 'assistant' : 'user',
    content: line.replace(/^[ua]:\s*/, ''),
  }));
  await run(`来自 ${args[fileIdx + 1]}`, msgs);
} else if (text) {
  await run(text, [{ role: 'user', content: text }]);
} else {
  for (const [title, msgs] of PRESETS) await run(title, msgs);
}

memory.close();
