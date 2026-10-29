// 记忆检索员
//
// 回答一个问题：他刚才这句话，让角色想起哪几件旧事？
//
// 为什么需要另一个模型调用：
//   SQLite 的中文全文检索在这套环境里走不通（见 memory.mjs 顶部那段实测）。
//   受控标签能匹配"咖啡"这种明确的词，但匹配不了绕弯的说法 ——
//   他说"又去老地方了"，该想起的是记着"常去的那家店"那条，纯字符串对不上。
//   这是个语义问题，只能交给模型。
//
// 和 summarize.mjs 一样，这不是角色本人在说话 —— 另一个系统提示，温度很低。
// 她的语气是后面 llm.chat 的事，这里只负责"想起哪些事"，不负责怎么说。
//
// 关键：**它够不着敏感条目。**
//   情绪低谷那类情景在 memory.recall() 里就被挡住了，压根不会出现在候选里，
//   所以检索员即使判断失误也翻不出来。这道闸在上游，不依赖模型的自觉。

import { LLM } from './llm.mjs';

const SYSTEM = `
你负责判断"角色"在听到对方这句话时，会自然地想起哪些旧事。

输入：
  · 他刚说的一句话
  · 一份候选清单，每条是「编号 | 什么时候 | 发生了什么 | 她当时的感觉」

输出：
  一个 JSON 数组，装着**最多 3 个**编号。没有该想起来的就是 []。

判断标准 —— 严格按这几条来：

1. **想起的标准是"这句话戳到了"，不是"这条有用"。**
   他说想喝咖啡 → 想起记着咖啡的那条。他随口说"晚上吃点啥" → []。

2. **宁少勿多。** 大多数日常对话一条都不该想起来。
   想起三件事塞给他，比一件不想更假。够不上 3 条就给 1 条，够不上 1 条就给 []。

3. **绕弯的说法也算戳到。** "又去老地方了"和"常去的那家店"是同一件事；
   "又要一个人过周末"和"孤独"是同一件事。这是你存在的理由，纯匹配做不到。

4. **看她的感觉，不只是事实。** 同样一件事，挑她当时反应更重的那条。

5. **不确定就给 []。** 想错了她会说出来一件根本没发生的事，那比不想起来糟得多。

只输出 JSON 数组，不要解释，不要 markdown 代码块。
`.trim();

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
      if (e.her_feeling) parts.push(`她当时：${e.her_feeling}`);
      return `· ${parts.join('　')}`;
    }).join('\n');

    const prompt = [
      `他刚说：「${text}」`,
      '',
      '候选：',
      list,
      '',
      '他这句话让她想起哪几条？输出编号的 JSON 数组。',
    ].join('\n');

    // 输出只有几个数字，max_tokens 给一点点就够 —— 这里快一秒是一秒，
    // 这个调用挡在她开口前面。
    const out = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 60 });

    const picked = parseIds(out);
    const ok = new Set(candidates.map((e) => e.id));
    return picked.filter((id) => ok.has(id)).slice(0, 3);   // 模型编的编号一律丢掉
  };
}
