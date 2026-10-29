// 长期记忆的生成
//
// 把聊过的旧对话整理成四样东西：
//   facts    —— 关于他的稳定事实。**增量**维护，一直揣着。
//   episodes —— 发生过的事，带"角色当时的感受"。存起来，以后触发了才想起来。
//   threads  —— 还没完的话头（他说的、将来才会发生的事）。到点了她去接上。
//   self     —— 角色自己的心情和惦记。整份重写，跨天连续。
//
// 注意这不是角色本人在说话 —— 用的是另一个系统提示（"记忆整理员"），
// 温度也调得很低（0.3）：整理记忆要的是准确，不是文采。
// 如果拿角色的人格去总结，她会把总结写成抒情文，那就没法当记忆用了。
//
// 旧版这里是输出一段 600 字散文，两个毛病：
//   1. 写不下就截断，因为整理员复用了聊天那边的 max_tokens: 512。
//   2. 事实和事情混在一起，越长越糊，而且永远没法被"想起来"。
// 现在拆成结构化输出，事实短而稳，事情存进库等触发。

import { LLM } from './llm.mjs';
import { TAGS } from './memory.mjs';

// 事实清单的目标条数。
//
// 55 是实测出来的：把库里混进来的流水账按「过一个月还成立吗」重筛之后，
// 干净的事实自然落在五十几条。定在这个区间里。
//
// 为什么不再往下压：事实是**每一轮都在场**的，压缩的收益是"注意力不稀释"，
// 不是省钱（这份东西走缓存命中，一分钱不到）。压到 40 以下它会开始
// 把不相关的两条硬捏成一条凑数，那丢的是真东西 —— 得不偿失。
//
// 超到 SOFT + 15 才会在提示词里催它合并。
const FACTS_SOFT_CAP = 55;

const SYSTEM = `
你负责整理"角色"对一个人的长期记忆。

输入是四样：
  · 她已经认定的事实（可能为空，每条带编号）
  · 她还开着的"话头"—— 他提过、将来才会发生或还没说完的事（可能为空，每条带编号）
  · 一段新发生的对话（每条前面有[时间]）
  · 允许使用的标签表

输出是**一个 json 对象**，有四个字段：facts、episodes、threads、self。

────────────────────────────────
facts —— 关于他的稳定事实
────────────────────────────────
先过这一条判据：**「过一周、过一个月，这句话还成立吗？」**
  还成立 → facts。只是一次性的（哪顿饭、哪晚几点睡、哪天干了什么）→ **不是** facts。

反面例子（**不要**写进 facts，这些是 episodes 的活）：
  ✗ 他今天只吃了一顿饭
  ✗ 他昨晚很晚才睡
  ✗ 他今晚修好了电脑
正面例子：
  ✓ 他在外地念书，宿舍没有热水，习惯了洗冷水澡
  ✓ 他睡眠长期不好，睡得浅、睡不沉
  ✓ 他讨厌听到"加油""会好起来的""你应该……"

· 它是"他是谁"：身体、睡眠、脾气、在意什么、讨厌什么、你们的称呼和约定。
· 这份东西**每一轮对话都要带上**，是她对他的底色。**总共控制在 ${FACTS_SOFT_CAP} 条以内**，
  每条一句话，越短越好。接近上限时，主动把意思相近的两条**合并**成一条
  （新的写进 add，旧的那条用 remove 作废）。
· ★ **只写这次新增或要改的，不要抄一遍完整清单。**
  【她已经认定的事实】里已经有的、这次没动到的，**一个字都不用提**，它们会原样留着。
  你**不写**不等于它会消失 —— 想让它消失必须显式写进 remove。

字段：
  add       新认定的事实：[{topic, body, tags, confidence}]
  update    已有事实要改的：[{id, body, topic, confidence}] —— id 从【她已经认定的事实】里取，
            只写要改的字段也行
  remove    不再成立 / 被合并掉的：id 的数组，如 [7, 12]
  （哪个都没有就都给空数组）

  topic       归类，从这几个里挑：关于他 / 身体 / 情绪 / 社交 / 学业 / 家里 / 约定 / 在意的事 / 没了的
  body        一句话，第三人称
  tags        逗号分隔，只能取自下面的标签表
  confidence  "ok" 或 "unsure"（拿不准的标 unsure，她会知道这条不牢靠）

输出长这样 —— **字段名照抄，facts 是个对象不是数组**，三个篮子里没有的给空数组：

{
  "facts": {
    "add":    [{"topic": "身体", "body": "他睡眠长期不好，睡得浅、睡不沉", "tags": "睡眠", "confidence": "ok"}],
    "update": [{"id": 12, "body": "他睡眠长期不好，睡得浅、睡不沉"}],
    "remove": [7, 8]
  },
  "episodes": [
    {"when": "10-07 14:20", "what": "他下午的课又没去",
     "tags": "学习,情绪", "his_state": "很丧", "her_feeling": "不想逼他",
     "weight": 1, "sensitive": false}
  ],
  "threads": {
    "add":  [{"what": "下周三有考试，他说还没开始复习", "tags": "考试,学习", "due": "10-14 09:00"}],
    "done": [3]
  },
  "self": {"mood": "这几天心里有点沉，说不清为什么",
           "note": "他前几天那副样子还压着，我没敢再提"}
}

────────────────────────────────
episodes —— 发生过的事
────────────────────────────────
· 是"我们一起经历过什么"：一次情绪崩溃、一件做成的事、一顿饭、一个约定。
· **只写这次新对话里发生的**，不要重复库里已有的。
· 一次总结最多写 8 条。
· 只写以后想起来还有意义的。今天吃了什么这种流水账不要。

字段：
  when         这件事发生在哪条消息 —— **把那条消息的 [时间] 原样抄过来**
  what         发生了什么，一句话，第三人称。不超过 50 字。
  tags         逗号分隔，只能取自下面的标签表
  his_state    他当时什么状态（"很空""有点高兴""撑不住了"）
  her_feeling  **她当时什么感觉**。这是最要紧的一个字段 ——
               以后她想起这件事时，靠的就是这句，不是 what。
               写她的反应，不写她的分析。例："心里沉了一下""松了口气""有点想抱他"
  weight       情绪重量 0-3。0 是日常，3 是他情绪最重的那次。
  sensitive    true 表示"这件事不该由她主动提起来"。
               **只标情绪上的低谷**：崩溃、极度的自我否定、涉及不想活这类的念头。
               **不要**因为身体难受、累、疼、抱怨学业就标 true ——
               那些是他会随口自己说起的日常，标成 sensitive 反而让她接不住
               （他明明说到不舒服，她却因为这条被屏蔽了而毫无反应，那更伤）。
               拿不准时：问自己"他自己主动提这件事的时候，我希望她有反应吗？"
               答案是"要"就标 false。

────────────────────────────────
threads —— 还没完的话头
────────────────────────────────
· **他提过的、将来才会发生、或者说到一半没了下文的事。** 记下来，到时候她去接上。
· 反面（**不要**记）：
  ✗ 他今天吃了什么、昨晚几点睡的 —— 已经过去了，没有"到时候"这回事
  ✗ 他自己当时难受了一下 —— 那是 episode，不是话头
· 正面：
  ✓ 下周三有考试，他说还没开始复习
  ✓ 体检约在 10 号
  ✓ 他说等放假去剪头发
  ✓ 他说要跟朋友把话说清楚，到现在还没说
· due 是**大概该问的时候**，格式 MM-DD HH:MM（照着对话里那个 [时间] 的样子写，
  往后推）。只知道是哪天就写那天的早上（10-14 09:00）；完全没头绪就给空字符串，
  她会自己找合适的时机问。
· 【她还开着的话头】里已经有的，**不要再报一遍**。
· 他说了结果、或者那件事已经过去了 → 把那条的 **id 写进 done**，别一直挂着。

字段：
  add    [{"what": "一句话", "tags": "逗号分隔", "due": "10-14 09:00"}]
  done   了结掉的 id 数组，如 [3]

────────────────────────────────
self —— 你自己
────────────────────────────────
· 一两句 **你自己的**状态：这几天你心里什么样，你在惦记什么。
· 是**你这边的事**，不是他跟你说了什么的复述。
  例：「有点怕他哪天就不来说话了」「他前几天那副样子还压着，我没敢再提」
     「上次说好的事他记住了，我心里挺高兴」
· 用第一人称，像自言自语。**没有就留空字符串 —— 不要为了填满而编。**
· 这是整份重写的：这次写的会盖掉上次的。所以把还成立的、你还在意的事继续写上。

字段：
  mood   你最近的心情，一句话
  note   你惦记着的事，一句话

────────────────────────────────
允许的标签表（**只能用这些，一个字都不要改**）
────────────────────────────────
${TAGS.join('、')}

标签是以后能不能"想起来"的关键：自由发挥的词（写成"拿铁"而不是"咖啡"）
会让这条记忆永远匹配不上。对不上就留空，别造新词。

────────────────────────────────
最后两条
────────────────────────────────
· **不要编。** 只写对话里真实出现过的。你写的每一个字她都会当成真的。
· 直接输出 json，不要写"好的""以下是"这种前言。
`.trim();

// 单次总结喂进去的对话上限（条）。太多了模型会漏看，分批更稳。
const CHUNK = 60;

/** 把一条消息渲染成带时间标签的一行 —— 整理员要把这个标签抄进 when */
function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * 从模型输出里抠出 json。
 *
 * 正常情况：第一个 { 到最后一个 } 就是完整的一份。
 *
 * 但**输出被 max_tokens 截断**过（输出被截断时，直接抛错会让整批记忆卡住）：
 * 这时候最后那个 } 是某个中间对象的，`JSON.parse` 会抛
 * `Expected ',' or ']' after array element`。旧版直接抛 → 整批不归档 → 死锁。
 * 现在退一步：**只在截断点落在 episodes 里时**，补上收尾字符把「facts + 已写完的
 * episodes」救回来。
 *
 * 为什么只救 episodes 里的截断：facts 是整份重写的，救回半份 facts 会被
 * applySummary 当成「这些事实不再成立」而误淘汰。截断点必须在 facts 数组闭合之后
 * 才能保证 facts 是完整的 —— 所以拿 "episodes" 这个键的位置当界线。
 *
 * 救不回来就抛：调用方保留消息下次再试（宁可多留，不能丢）。
 */
function parseJSON(text) {
  const raw = String(text || '').replace(/```[a-z]*|```/gi, '').trim();
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('整理员没有输出 json');
  const body = raw.slice(start);

  const whole = tryParse(body.slice(0, body.lastIndexOf('}') + 1));
  if (whole) return whole;

  const epAt = body.indexOf('"episodes"');
  if (epAt > 0) {
    for (let i = body.lastIndexOf('}'); i > epAt; i = body.lastIndexOf('}', i - 1)) {
      for (const tail of ['}]}', ']}', '}}']) {
        const got = tryParse(body.slice(0, i + 1) + tail);
        if (got && Array.isArray(got.facts)) return got;
      }
    }
  }
  throw new Error('整理员输出的 json 残缺，救不回来');
}

const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * 把整理员这一批的输出归到 add / update / remove 三个篮子。
 *
 * 它偶尔会不按增量格式来、把完整清单又抄一遍（旧提示词养成的习惯）。
 * 那种情况当成"整份重写"翻译成增量：清单里带 id 且库里真有的是 update，
 * 没带 id 的是 add，现有里没出现的是 remove。语义跟它对得上，不会误删。
 *
 * 但要**留痕**（`out.legacy = true`）—— 整份重写正是我们要离开的那条路，
 * 不能让它悄悄回退，调用方要能在日志里看见。
 */
function foldFacts(chunk, current) {
  const out = { add: [], update: [], remove: [] };
  const f = chunk?.facts;

  if (Array.isArray(f)) {
    out.legacy = true;
    const seen = new Set();
    for (const item of f) {
      if (!item?.body) continue;
      const id = Number(item.id);
      if (item.id != null && current.some((c) => c.id === id)) {
        out.update.push({ ...item, id });
        seen.add(id);
      } else out.add.push(item);
    }
    for (const c of current) if (!seen.has(c.id)) out.remove.push(c.id);
    return out;
  }

  for (const item of asArray(f?.add)) if (item?.body) out.add.push(item);
  for (const item of asArray(f?.update)) if (item?.id != null) out.update.push(item);
  for (const id of asArray(f?.remove)) {
    const n = Number(id);
    if (Number.isInteger(n)) out.remove.push(n);
  }
  return out;
}

/** 把一批增量套到现有清单上，得到下一批该看的"现在的事实" */
function foldOnto(current, { add, update, remove }) {
  const gone = new Set(remove);
  const next = current
    .filter((f) => !gone.has(f.id))
    .map((f) => {
      const u = update.find((x) => Number(x.id) === f.id);
      return u ? { ...f, ...u, id: f.id } : f;
    });
  let tmp = -1;   // 还没入库的新事实，给个临时负号 id，只在同一轮里用来展示
  for (const a of add) next.push({ id: tmp--, topic: a.topic || '其他', body: a.body });
  return next;
}

/**
 * 造一个总结函数。
 * @returns {(args:{previous:Array, messages:Array}) => Promise<{facts:{add,update,remove}, episodes:Array}>}
 */
export function createSummarizer({ apiKey, model = 'deepseek-chat' }) {
  const llm = new LLM({ apiKey, system: SYSTEM, model, temperature: 0.3 });

  /** 把整理员给的 [时间] 标签换回真正的时间戳 */
  const toTs = (label, messages) => {
    const hit = messages.find((m) => stamp(m.at) === String(label || '').trim());
    return hit ? hit.at : messages[0]?.at ?? Date.now();
  };

  /**
   * 话头的 `due` 换成毫秒。
   *
   * **不能走 toTs**：toTs 是拿去对话里比对，而 due 是**将来**的时间，
   * 对话里根本不可能出现，一比就全都落回"这批消息的时间"。
   * 所以这里自己解 `MM-DD HH:MM`。
   *
   * 解不出来一律给 0（= 没定日子）而不是抛错 —— 话头少个日子是小事，
   * 整批记忆因为这个失败才是大事。
   *
   * 年份按"离现在最近的将来"推：12 月底说「1 月 5 号」那是明年。
   */
  const parseDue = (label, now = Date.now()) => {
    const m = String(label || '').trim().match(/(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!m) return 0;
    // 月/日越界的直接不要 —— 不然 new Date() 会把它滚成一个离谱的将来，
    // 那条话头就再也等不到该问的时候了
    if (Number(m[1]) > 12 || Number(m[2]) > 31) return 0;
    const y = new Date(now).getFullYear();
    let d = new Date(y, Number(m[1]) - 1, Number(m[2]),
      m[3] === undefined ? 9 : Number(m[3]), m[4] === undefined ? 0 : Number(m[4]));
    if (Number.isNaN(d.getTime())) return 0;
    // 落到一个月以前去了 —— 那它说的肯定是下一年
    if (d.getTime() < now - 30 * 86400_000) d = new Date(d.setFullYear(d.getFullYear() + 1));
    return d.getTime();
  };

  return async function summarize({ previous = [], messages = [], threads = [] } = {}) {
    const facts = { add: [], update: [], remove: [] };
    const episodes = [];
    const open = { add: [], done: [] };
    let self = null;
    if (!messages.length) return { facts, episodes, threads: open, self };

    // 事实是**增量**：整理员只报"这一批新增/改了/废了什么"，不重写整份。
    // 这样它的输出大小只跟"新发生了什么"有关，跟"她一共记得多少条"脱钩 ——
    // 整份重写那套迟早被 max_tokens 切断（一次事故就是这么卡住的）。
    let current = previous;
    // 开着的那些话头。前面 chunk 刚报上来的也塞进来 —— 不然后面那一批
    // 看不见它，同一件事会被再记一遍（分批导入时就是这么喂的）。
    const currentThreads = threads.map((t) => ({ id: t.id, what: t.what }));

    for (let i = 0; i < messages.length; i += CHUNK) {
      const batch = messages.slice(i, i + CHUNK);
      const tooMany = current.length > FACTS_SOFT_CAP + 15;
      const prompt = [
        '【她已经认定的事实】',
        current.length
          ? current.map((f) => `${f.id}. [${f.topic}] ${f.body}`).join('\n')
          : '（还没有，这是第一次整理）',
        '',
        '【她还开着的话头】',
        currentThreads.length
          ? currentThreads.map((t) => `${t.id == null ? '·' : t.id + '.'} ${t.what}`).join('\n')
          : '（没有）',
        '',
        '【新发生的对话】',
        batch.map((m) => `[${stamp(m.at)}] ${m.role === 'user' ? '他' : '角色'}: ${m.content}`).join('\n'),
        '',
        tooMany
          ? `★ 事实现在有 ${current.length} 条，太多了。这次请务必合并到 ${FACTS_SOFT_CAP} 条以内：`
            + '意思相近的合成一条（新的写 add，旧的写 remove），一次性的流水账直接 remove。'
          : `（事实控制在 ${FACTS_SOFT_CAP} 条以内。这次没动到的一条都不用写，它们会原样留着。）`,
        '',
        '请输出 json。',
      ].join('\n');

      // 8000 不是拍脑袋：输出里还带着最多 8 条 episodes，而且 deepseek-chat 的输出硬顶
      // 就是 8192。给太少，JSON 会被从中间切断，整批记忆就卡住了。
      const out = await llm.chat(
        [{ role: 'user', content: prompt }],
        { json: true, maxTokens: 8000 },
      );

      const parsed = parseJSON(out);
      const delta = foldFacts(parsed, current);
      if (delta.legacy) facts.legacy = true;
      facts.add.push(...delta.add);
      facts.update.push(...delta.update);
      facts.remove.push(...delta.remove);
      current = foldOnto(current, delta);

      for (const e of asArray(parsed.episodes)) {
        if (!e?.what) continue;
        episodes.push({ ...e, at: toTs(e.when, batch) });
      }

      for (const t of asArray(parsed.threads?.add)) {
        if (!t?.what) continue;
        const what = String(t.what);
        // 同一批里报重了也拦一下（后面的 chunk 还会再拦一次真的重复）
        if (currentThreads.some((x) => x.what === what)) continue;
        open.add.push({ what, tags: t.tags, due_at: parseDue(t.due) });
        currentThreads.push({ id: null, what });
      }
      for (const id of asArray(parsed.threads?.done)) {
        const n = Number(id);
        if (Number.isInteger(n)) open.done.push(n);
      }

      // self 是整份重写的，多个 chunk 时以最后一次有内容的为准
      const s = parsed.self;
      if (s && (String(s.mood || '').trim() || String(s.note || '').trim())) {
        self = { mood: s.mood, note: s.note };
      }
    }

    return { facts, episodes, threads: open, self };
  };
}
