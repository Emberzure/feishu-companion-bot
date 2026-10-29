// 角色自己的日记
//
// 和记忆整理员（summarize.mjs）是两件事：
//   整理员写「发生了什么」，给未来的检索用；
//   日记写「她一个人时怎么想」，给她的底色用。
//
// 所以这里用的是另一个低温柔模型，不是角色本人的人格 ——
// 拿她聊天的语气来写日记，会写成一段发给他的消息，不像写给自己。

import { LLM } from './llm.mjs';
import { localDay, partOfDay } from './clock.mjs';

const SYSTEM = [
  '你替角色写日记。你不是助手，也不是对话摘要员。',
  '你写的只是她自己的那一部分：他不在的时候，她心里怎么过的；',
  '他哪句话还留在她那里；她手上那件事做到哪了。',
  '',
  '要求：',
  '- 第一人称，2-4 句，像写给自己看的。不是发给他的消息，不要称呼他。',
  '- 只写材料里有的事，不编新的人、地点、事件。',
  '- 不要逐条复述对话，不要写「他今天说……」这种汇报。可以写你还在想的那一句。',
  '- 她可以难受，也可以对他有情绪；但不索取、不指责、不威胁。',
  '- 不要每篇都忧郁。没什么大事，就写一件很小的、具体的。',
  '- 不要把日记写成安慰他的话，也不要在里面安排明天必须做什么。',
  '',
  '输出严格 json：{"thought":"...","mood":"low|ok|good","shareable":true}',
  'shareable：如果这篇里有自伤、酒、死亡、身体伤口这类内容，写 false；其余写 true。',
].join('\n');

/** 日记里出现这些内容时，一律不许她主动讲出来。 */
const SENSITIVE = /自伤|自杀|想死|不想活|吞药|割腕|喝酒|喝醉|醉|崩溃|流血|伤口/;

/** 模型偶尔会包一层 ```json，或者前后带解释。只取最外层对象。 */
function parseJSON(text) {
  const raw = String(text || '').trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(clean); } catch { /* 继续试 */ }
  const i = clean.indexOf('{');
  const j = clean.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(clean.slice(i, j + 1)); } catch { /* 放弃 */ }
  }
  throw new Error(`日记不是合法 json：${raw.slice(0, 160)}`);
}

const hm = (at) => new Date(at).toLocaleTimeString('zh-CN', {
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * @returns {(job:{day:string,now:number,messages:Array,life:object,selfState:object,lastDiary:object}) =>
 *   Promise<{thought:string,mood:string,shareable:boolean}>}
 */
export function createReflector({ apiKey, model = 'deepseek-chat' }) {
  const llm = new LLM({ apiKey, system: SYSTEM, model, temperature: 0.5 });

  return async function reflect({ day, now = Date.now(), messages = [], life = {}, selfState, lastDiary } = {}) {
    const d = new Date(now);
    const conversation = messages.length
      ? messages.map((m) => `[${hm(m.at)}] ${m.role === 'user' ? '他' : '角色'}：${clean(m.content, 300)}`).join('\n')
      : '（今天还没说话）';

    const prompt = [
      `【今天】${day || localDay(d)} ${partOfDay(d)} ${hm(now)}`,
      `【你今天的天气】${life.mood || 'ok'}：${life.moodCause || '（没写）'}`,
      `【今天大概想做的事】${life.plan || '（没写）'}`,
      `【你此刻】${life.activity || '（没写）'}${life.body ? `｜身体：${life.body}` : ''}`,
      selfState?.mood || selfState?.note
        ? `【你最近的状态】你心里：${clean(selfState.mood, 200) || '（没写）'}`
          + `；你惦记着：${clean(selfState.note, 200) || '（没写）'}`
        : '【你最近的状态】（没有）',
      '',
      '【今天发生的对话】',
      conversation,
      '',
      lastDiary?.thought
        ? `【你上一次写下的】${clean(lastDiary.thought, 400)}\n（别重复同一层意思，换一个具体的东西写。）`
        : '【你上一次写下的】（还没有）',
      '',
      '请写今天这一篇。只写材料里有的，不编。',
    ].join('\n');

    const out = await llm.chat(
      [{ role: 'user', content: prompt }],
      { json: true, maxTokens: 600 },
    );
    const parsed = parseJSON(out);

    const thought = clean(parsed.thought, 800);
    if (!thought) throw new Error('日记内容为空');

    const mood = ['low', 'ok', 'good'].includes(parsed.mood) ? parsed.mood : (life.mood || 'ok');
    // 涉及自伤/酒/伤口的，不让它进入主动分享；只作为她自己的底色。
    const shareable = parsed.shareable !== false && !SENSITIVE.test(thought);

    return { thought, mood, shareable };
  };
}
