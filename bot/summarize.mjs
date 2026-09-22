// 长期记忆的生成（"记忆整理员"）：把旧对话整理成 facts 和 episodes。
//
// 注意这不是角色本人在说话 —— 用的是另一个系统提示，温度 0.3。
// 整理记忆要的是准确不是文采；拿角色人设去总结，它会写成抒情文，没法用。
//
// 输出必须结构化：旧版写一段 600 字散文，结果会截断、
// 事实和事情混在一起，而且永远没法被单独"想起来"。

import fs from 'node:fs';
import { LLM } from './llm.mjs';
import { TAGS } from './memory.mjs';

const SYSTEM = fs.readFileSync(new URL('./prompts/summarizer.md', import.meta.url), 'utf8')
  .replace('{{TAGS}}', TAGS.join('、'))
  .trim();

// 单次总结喂进去的对话上限（条）。太多了模型会漏看，分批更稳。
const CHUNK = 60;

/** 把一条消息渲染成带时间标签的一行 —— 整理员要把这个标签抄进 when */
function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 从模型输出里抠出 json。
 * 开了 json_object 模式基本不会失手，但网络抖一下拿到半截也是有的 ——
 * 解析不出来就抛，调用方会保留消息下次再试。宁可多留，不能丢。
 */
function parseJSON(text) {
  const raw = String(text || '').replace(/```[a-z]*|```/gi, '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('整理员没有输出 json');
  return JSON.parse(m[0]);
}

/**
 * 造一个总结函数。
 * @returns {(args:{previous:Array, messages:Array}) => Promise<{facts:Array, episodes:Array}>}
 */
export function createSummarizer({ apiKey, model = 'deepseek-chat' }) {
  // 整理员要写整份事实清单 + 一批情景，512 根本不够 —— 旧版就是被这个砍断的。
  const llm = new LLM({ apiKey, system: SYSTEM, model, temperature: 0.3 });

  /** 把整理员给的 [时间] 标签换回真正的时间戳 */
  const toTs = (label, messages) => {
    const hit = messages.find((m) => stamp(m.at) === String(label || '').trim());
    return hit ? hit.at : messages[0]?.at ?? Date.now();
  };

  return async function summarize({ previous = [], messages = [] } = {}) {
    if (!messages.length) return { facts: previous, episodes: [] };

    // 事实整份重写，所以这里滚动的只有事实；情景是每批只增不改。
    let facts = previous;
    const episodes = [];

    for (let i = 0; i < messages.length; i += CHUNK) {
      const batch = messages.slice(i, i + CHUNK);
      const prompt = [
        '【角色已经认定的事实】',
        facts.length
          ? facts.map((f) => `${f.id}. [${f.topic}] ${f.body}`).join('\n')
          : '（还没有，这是第一次整理）',
        '',
        '【新发生的对话】',
        batch.map((m) => `[${stamp(m.at)}] ${m.role === 'user' ? '他' : '角色'}: ${m.content}`).join('\n'),
        '',
        '请输出更新后的 json。',
      ].join('\n');

      const out = await llm.chat(
        [{ role: 'user', content: prompt }],
        { json: true, maxTokens: 3000 },
      );

      const parsed = parseJSON(out);
      // 只认带 body 的事实、带 what 的情景 —— 半截的输出不要混进去
      facts = (Array.isArray(parsed.facts) ? parsed.facts : []).filter((f) => f?.body);
      for (const e of (Array.isArray(parsed.episodes) ? parsed.episodes : [])) {
        if (!e?.what) continue;
        episodes.push({ ...e, at: toTs(e.when, batch) });
      }
    }

    return { facts, episodes };
  };
}
