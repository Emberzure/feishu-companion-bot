#!/usr/bin/env node
// 调试台
//
// 改完人设或语气，用这个先试，满意了再重启 bot。
// 它真调 DeepSeek，【只读 data/】不改任何东西，也不影响正在跑的 bot。
//
//   ./try                     跑几个预设场景
//   ./try "他说的话"           试一句
//   ./try -m "他说的话"        带上长期记忆试一句（会打印角色想起了什么）
//   ./try -f 文件.txt          从文件读一段对话来试（每行一条，u:/a: 开头区分是谁）
//
// 输出里会标出【会发几条】—— 有些毛病（比如角色又开始刷屏）在这里就能看出来。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEnvFile, loadPersona, sendBubbles,
} from './core.mjs';
import { LLM } from './llm.mjs';
import { Memory } from './memory.mjs';
import { createRetriever } from './recall.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
const personaPath = env.PERSONA_PATH || path.join(ROOT, 'persona.md');

const persona = loadPersona(personaPath);
const llm = new LLM({ apiKey: env.DEEPSEEK_API_KEY, system: persona });
const retrieve = createRetriever({ apiKey: env.DEEPSEEK_API_KEY });

// 记忆是【只读】的：recall / getMemory 都只查不写，所以 bot 在跑也能同时用。
// 唯一会动 data/ 的是 new Memory() 建库那一下 —— 库已经在了就是空操作。
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
  ['他情绪低落', [{ role: 'user', content: '今天真的撑不住了，忙了一整天，晚上一个人坐着突然觉得什么都挺没意思的' }]],
  ['他问你一个试探的问题', [{ role: 'user', content: '你是我的谁' }]],
  ['他没事找事', [{ role: 'user', content: '在吗' }]],
];

const args = process.argv.slice(2);
const useMem = args.includes('-m') || args.includes('--mem');
const fileIdx = args.findIndex((a) => a === '-f' || a === '--file');
const text = args.filter((a) => !a.startsWith('-')).join(' ').trim();

const facts = useMem ? memory.getMemory(key) : '';
if (useMem) {
  const s = memory.stats(key);
  console.log(`[记忆] 事实 ${s.facts} 条 / ${facts.length} 字，`
    + `情景 ${s.episodes} 件（其中不主动提的 ${s.sensitive} 件）\n`);
  if (!s.facts && !s.episodes) {
    console.log('   （库里还是空的 —— 正常，正常聊几次就有了）\n');
  }
}

async function run(title, messages) {
  // 走一遍和正式回复完全一样的记忆流程，好让角色想起的东西在调试台里就能看见
  const said = messages.at(-1)?.content || '';
  let recall = [];
  if (useMem) {
    const candidates = memory.recall(key, said);
    if (candidates.length) {
      const ids = await retrieve({ text: said, candidates });
      recall = candidates.filter((c) => ids.includes(c.id));
    }
  }

  const out = await llm.chat(messages, { memory: facts, recall });
  const bubbles = [];
  await sendBubbles(async (t) => { bubbles.push(t); }, out);

  console.log(`─── ${title} ───`);
  if (useMem) {
    console.log(recall.length
      ? `  [想起] ${recall.map((e) => `${e.what.slice(0, 22)}「${e.her_feeling || ''}」`).join(' / ')}`
      : '  [想起] 什么也没想起来');
  }
  for (const b of bubbles) console.log(`  ▸ ${b}`);
  console.log(`  〔${out.length} 字 / 会发 ${bubbles.length} 条〕\n`);
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
