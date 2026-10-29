// 模型对话接口（DeepSeek）
//
// DeepSeek 的接口和 OpenAI 完全兼容，所以就是普通的 chat/completions。
// 用 deepseek-chat（V3）而不是 deepseek-reasoner（R1）：
// R1 会先想一大段再开口，延迟高，放在需要即时回应的陪伴场景里
// 会让人觉得她在愣神。情感陪伴要的是即时出现，不是深思熟虑。

import { clockish, gapWords, dayDiff, partOfDay, nowBlock } from './clock.mjs';
import { lifeBlock } from './life.mjs';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

/**
 * 时间说成人话。
 *
 * 人记得的是"上礼拜""那天晚上"，不是"2026-09-17"。给她日期她就会报日期，
 * 一报日期立刻变成在念档案。所以这里一律换算成模糊说法。
 *
 * **按本地日分档，不按"距今几小时"分档。** 从前是看小时数的，于是凌晨
 * 00:30 把昨晚 23:00 的事说成「今天早些时候」，而早上 08:00 又把同一件事
 * 说成「今天早些时候」—— 按小时切，跨过午夜就错一天。
 * 档内的"刚才"也从 6 小时收到 2 小时：6 小时前已经不叫刚才了，
 * 而且那样会和每轮注入的【现在】块（"他上一次说话是今天早上 8:33，7 小时前"）
 * 对不上，她会收到两个互相打架的时间信号。
 */
function fuzzyTime(at, now = Date.now()) {
  const d = dayDiff(at, now);
  const part = partOfDay(new Date(at));

  if (d <= 0) return (now - at) / 3_600_000 < 2 ? '刚才' : '今天早些时候';
  if (d === 1) return (part === '晚上' || part === '深夜') ? '昨晚' : `昨天${part}`;
  if (d === 2) return `前天${part}`;
  if (d < 7) return '前几天';
  if (d < 14) return '上礼拜';
  if (d < 30) return '前阵子';
  return `${new Date(at).getMonth() + 1}月那阵子`;
}

// 相邻两条隔这么久，就认为中间断开了（他睡了一觉 / 去上课了 / 一天没说话）
const GAP = 2 * 3_600_000;

/**
 * 把 history 渲染成能发给模型的 messages。
 *
 * 两件事：
 *   1. **剥掉 `at`** —— memory.context() 现在返回 {role, content, at}，
 *      多出来的字段会被原样塞进请求体，DeepSeek 不认。
 *   2. **在断点处插一条 system 分隔行**。只标位置，**不给每条消息加时间戳** ——
 *      时间戳进 content 她会照着学，下一句就开始报日期（她连人设里
 *      "不写括号旁白"都照写不误，模仿 content 这事上她学得极快）。
 *
 * 分隔行用 role:'system' 是**探过的**：实测 DeepSeek 接受数组中间的
 * system（那是唯一能既准又不污染 content 的写法）。
 */
export function renderHistory(history = [], now = Date.now()) {
  const out = [];
  let prevAt = 0;
  for (const m of history) {
    const at = Number(m.at) || 0;
    if (at && prevAt && at - prevAt >= GAP) {
      const g = gapWords(at - prevAt);
      // 数字和汉字之间要空格（"隔了 9 小时"），纯汉字不要（"隔了一天"）
      const gap = /^\d/.test(g) ? ` ${g}` : g;
      // 两个端点都以**真正的现在**为参照。别拿断点自己当参照（`clockish(x, at)`）：
      // 那样"昨天断的那次"会被写成"今天"，因为参照点也跟着挪到了那天。
      // 不用圆括号包时间 —— 人设里禁「括号旁白」，而她模仿 content 极快。
      // 实测这个分隔行并没有让她多写括号（6/6 vs 6/6），但也没必要往流里喂这个形状。
      out.push({
        role: 'system',
        content: `—— 隔了${gap} · ${clockish(prevAt, now)} → ${clockish(at, now)} ——`,
      });
    }
    out.push({ role: m.role, content: m.content });
    if (at) prevAt = at;   // 没带 at 的（./try 手搭的那种）不参与断点判断
  }
  return out;
}

/** 把一条情景渲染成"她的回忆"，不是一条数据库记录 */
function renderEpisode(e) {
  const when = fuzzyTime(e.at);
  let s = `${when}，${e.what}`;
  if (e.her_feeling) s += `。你当时${e.her_feeling}`;
  return s;
}

export class LLM {
  constructor({ apiKey, model = 'deepseek-chat', system, temperature = 1.0 }) {
    if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY');
    this.apiKey = apiKey;
    this.model = model;
    this.system = system;

    // temperature 曾经给到 1.3（DeepSeek 官方给「通用对话」的推荐值），
    // 想着回复能活一点、别像客服。但实测 1.3 开始出现词序错乱：
    //   "灯开着手机就行亮不了多久，犯懒也定个二十 分钟字闹完再找座"
    //   "……行吧那是原码里有的。"
    // 这不是语气问题，是 token 级乱码 —— 温度越高越容易崩。
    // 降到 1.0：还留得住破折号和短句的劲儿，但不再胡说。
    this.temperature = temperature;
  }

  /**
   * 发请求，失败自动重试。
   *
   * 为什么要重试：家里的网络会间歇性掐连接 ——
   * 报的是 `tls: bad record MAC` 或者 `HTTP2 protocol error`。
   * 这不是 DeepSeek 的问题，是链路的毛病（并发一高就犯）。重试一次基本都能过。
   * 不重试的话，用户发的那条消息就白发了，角色一个字都不回。
   *
   * 哪些值得重试：
   *   · 网络层错误（fetch 直接抛）—— 重试
   *   · 5xx / 429（服务端抖动、限流）—— 重试
   *   · 4xx（key 不对、额度用完、参数错）—— 不重试，直接抛，重试一百次也一样
   */
  async #request(body) {
    const RETRIES = 3;
    let lastErr;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let res;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(90_000),
        });
      } catch (e) {
        lastErr = e;                                  // 网络层，可重试
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }

      if (res.ok) return res;

      const detail = await res.text().catch(() => '');
      const err = new Error(`DeepSeek ${res.status}: ${detail.slice(0, 300)}`);
      if (res.status < 500 && res.status !== 429) throw err;   // 我们自己的错，别重试

      lastErr = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 800 * attempt));
    }

    throw lastErr;
  }

  /**
   * @param {Array<{role:string,content:string}>} history 历史消息（不含 system）
   * @param {object} [opts]
   * @param {string} [opts.hint] 临时插一句系统提示（比如「该你主动开口了」）
   * @param {string} [opts.memory] 长期记忆：关于他的稳定事实（一直带着）
   * @param {{mood?:string,note?:string}} [opts.selfState] 她自己的状态（她的心情/惦记）
   * @param {object} [opts.life] 她自己的日子（此刻/天气/日记），见 life.mjs
   * @param {Array}  [opts.recall] 检索到的旧事 —— 她"想起来"的那几件
   * @param {{now:number,lastUserAt?:number,lastBotAt?:number}} [opts.times]
   *        时间三件套（毫秒）。给了就注入【现在】，并在历史断点处插分隔行。
   *        传的是**原始时间**不是渲染好的文字 —— 块和历史分隔行必须用同一个
   *        参照点，拆成两个参数迟早会出现"块里说是今天、分隔行说是昨天"。
   * @param {number} [opts.maxTokens] 覆盖默认输出上限
   * @param {boolean}[opts.json] 要模型输出严格 json（整理员用）
   * @param {string} [opts.voice] 「这条用语音还是打字」的说明。
   *        放在【现在】之后、历史之前 —— 离生成最近，她最不容易漏掉 [[v]]。
   */
  async chat(history, {
    hint, memory, selfState, life, recall, times, maxTokens, json, voice,
  } = {}) {
    const messages = [{ role: 'system', content: this.system }];

    // 长期记忆放在历史之前 —— 先让她知道"他是谁"，再看具体聊了什么。
    // 特意叮嘱别复述：不然她会张口就是"我记得你上次说过…"，像在展示数据库。
    if (memory) {
      messages.push({
        role: 'system',
        content: [
          '【你记得的事】',
          '下面是你对这个人的记忆笔记。不要复述它，也不要问"你还记得吗"，',
          '它只是让你知道他是谁、他在经历什么。自然地用就行。',
          '',
          memory,
        ].join('\n'),
      });
    }

    // 她自己的状态。放在"关于他"之后、当下之前 —— 先知道他是谁，再是她这几天
    // 什么样，然后才是这一刻。
    //
    // ⚠️ 这段是有代价的：往提示词里塞"她自己的心情"，最省事的写法会让她
    // 一开口就汇报情绪（"我最近有点低落"），那正好是把担子递给他 ——
    // 人设第七节明令禁止的方向（他给你的，永远要比你背走的多）。
    // 所以这里不是"告诉她她心情不好"，是**给她一个底色**，并当场按住汇报的冲动。
    if (selfState && (selfState.mood || selfState.note)) {
      messages.push({
        role: 'system',
        content: [
          '【你最近】',
          '这是**你自己**的状态，不是他要你汇报的东西。别把一整段心情念出来，',
          '让它渗进你说话的语气、你在意什么、你什么时候不说话。',
          '但你不是永远稳的那一个：真难受的时候，可以说一句「我今天也很难受」。',
          selfState.mood ? `你心里：${selfState.mood}` : '',
          selfState.note ? `你惦记着：${selfState.note}` : '',
          '★ 你可以让他接住你一点，但不要把整个担子交给他。',
          '你也会有难受的时候，可以说出来，不用永远装成更稳的那一个。',
          '他来找你，是来歇脚的 —— 大多数时候，他给你的要比你背走的多。',
        ].filter(Boolean).join('\n'),
      });
    }

    // 她自己的日子。放在"他是谁""她这几天怎么样"之后、旧事之前：
    // 先知道他是谁，再是她今天具体在过什么。
    // 这一块是底色，不是汇报材料 —— 约束都写在 life.mjs 的 lifeBlock 里。
    if (life) {
      messages.push({ role: 'system', content: lifeBlock(life, times?.now ?? Date.now()) });
    }

    // 想起来的旧事。跟上面那份"事实"分开是有意的：
    //   事实是背景，她一直知道，所以不能提"我记得"；
    //   旧事是当下被戳到才浮现的，要的是**想起来的那个动作**，不是复述内容。
    if (recall?.length) {
      messages.push({
        role: 'system',
        content: [
          '【你想起的事】',
          '下面几件是你自己记着的，不是别人给你的资料。',
          '语气要像想起来了，不像查档案：可以含糊、可以只记得一半。',
          '别一条条报，别报日期，别问"你还记得吗"。',
          '想起来是因为他刚说的那句话戳到了，所以自然长在对话里就行。',
          '',
          recall.map((e) => `- ${renderEpisode(e)}`).join('\n'),
        ].join('\n'),
      });
    }

    if (hint) messages.push({ role: 'system', content: hint });

    // 【现在】放最后一块 system —— 紧贴着它要解释的那段历史。
    // 位置也是挑过的：persona / facts / recall / hint 都是稳定的，
    // 把每分钟都在变的东西放在它们之后，缓存能命中的前缀最长。
    const at = times?.now ?? Date.now();
    if (times) messages.push({ role: 'system', content: nowBlock(at, times) });

    // 语音/文字的说明放在最后一块 system：它管的是「这一条怎么发」，
    // 离生成越近越好。不放人设里，因为语音随时可能被关掉。
    if (voice) messages.push({ role: 'system', content: voice });

    messages.push(...renderHistory(history, at));

    const res = await this.#request(JSON.stringify({
      model: this.model,
      messages,
      temperature: this.temperature,
      // 她会卡进复读：「行，信你，信你这次哈」这种。
      // 这两个惩罚项就是压复读的，0.3 足够打断循环，又不至于让她跑题。
      frequency_penalty: 0.3,
      presence_penalty: 0.2,
      // 以前是 2048，等于放任她写长。512 token 差不多 350 字，
      // 聊天够用；真写超了也该被截断，而不是刷一屏。
      //
      // 但**别拿这个值去调记忆整理员** —— 整理员要写整份事实清单，
      // 512 会把输出切在半句话上。整理员和检索员各自传自己的值。
      max_tokens: maxTokens ?? 512,
      stream: false,
      // json 模式只给整理员和检索员用 —— 聊天那边绝不能开，
      // 她要是把回复写成 json，那场面没法看。
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }));

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('DeepSeek 返回了空内容');
    return text;
  }
}
