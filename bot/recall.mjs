// 记忆检索员：判断他刚说的这句话，让角色想起哪几件旧事。
//
// 为什么需要一次模型调用：受控标签能匹配"咖啡"这种明确的词，匹配不了绕弯的说法 ——
// 他说"又去老地方了"，该想起的是记着"常去的那家店"那条。这是语义问题。
//
// 它够不着敏感条目：那类在 memory.recall() 就被挡住了，压根不进候选。
// 这道闸在上游，不依赖模型的自觉。

import fs from 'node:fs';
import { LLM } from './llm.mjs';

const SYSTEM = fs.readFileSync(new URL('./prompts/retriever.md', import.meta.url), 'utf8').trim();

/** 从模型输出里把 JSON 数组抠出来 —— 它偶尔会裹一层 ```json */
function parseIds(text) {
  const raw = String(text || '').replace(/```[a-z]*|```/gi, '').trim();
  const m = raw.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.map(Number).filter(Number.isInteger) : [];
  } catch { return []; }
}

/**
 * 造一个检索函数。
 * @returns {(args:{text:string, candidates:Array}) => Promise<number[]>} 选中的情景 id
 */
export function createRetriever({ apiKey, model = 'deepseek-chat' }) {
  const llm = new LLM({ apiKey, system: SYSTEM, model, temperature: 0.2 });

  return async function retrieve({ text = '', candidates = [] } = {}) {
    if (!candidates.length) return [];

    const list = candidates.map((e) => {
      const when = new Date(e.at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      const parts = [`${e.id} | ${when} | ${e.what}`];
      if (e.his_state) parts.push(`他当时：${e.his_state}`);
      if (e.her_feeling) parts.push(`角色当时：${e.her_feeling}`);
      return `· ${parts.join('　')}`;
    }).join('\n');

    const prompt = [
      `他刚说：「${text}」`,
      '',
      '候选：',
      list,
      '',
      '他这句话让角色想起哪几条？输出编号的 JSON 数组。',
    ].join('\n');

    // 输出只有几个数字，max_tokens 给一点点就够 —— 这里快一秒是一秒，
    // 这个调用挡在角色开口前面。
    const out = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 60 });

    const picked = parseIds(out);
    const ok = new Set(candidates.map((e) => e.id));
    return picked.filter((id) => ok.has(id)).slice(0, 3);   // 模型编的编号一律丢掉
  };
}
