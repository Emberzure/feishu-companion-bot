// 记忆（SQLite）
//
// 三层：
//   messages  —— 原样的对话。**永不删除**，浓缩过的只是打个 archived 标记。
//   facts     —— 关于他的稳定事实（身体、睡眠、在做什么）。一直揣在上下文里。
//   episodes  —— 发生过的事。**带"角色当时的感受"**。平时不出现，被触发了才想起来。
//
// 为什么要分 facts 和 episodes：
//   事实是"他是谁"，每次都要知道，所以一直带着，不能长。
//   事情是"我们一起经历过什么"，一辈子也带不完，所以存起来，需要时才捞。
//   旧版把两样都塞进一段 600 字的散文里，结果是又长又不准，最后还写崩了。
//
// 为什么不用 SQLite 的全文检索：
//   实测过，三条路都堵死 ——
//     · unicode61（默认分词器）根本不认中文，整句当成一个词，查中文返回 0
//     · trigram 只认完全相同的三字串，绕一点的说法就查不到
//     · icu 分词器没编译进 node 自带的 SQLite（no such tokenizer: icu）
//   所以检索走「受控标签词表」（见 TAGS）+ 可选的 LLM 记忆检索员，
//   不指望数据库替我们做中文语义匹配。
//
// 这个库只增不删：archived 只是个标记，原文永远在。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { localDay } from './clock.mjs';
import { activityAt, dailyWeather, startOfDay } from './life.mjs';

// 短期记忆保留多少条（不归档、原样进上下文）
const KEEP_RECENT = 30;
// 溢出攒到这么多条才总结一次；同时也是**一次交给整理员的上限**
// （两个含义绑在一起是有意的，见 takeForSummary 里那段说明）
const SUMMARY_BATCH = 20;

/**
 * 受控标签词表。
 *
 * 这是整套检索的地基：整理员给每条情景打这里的标签，她说话时拿他这句话
 * 去比对同一张表。**词表必须两边共用**，不然标签打得再准也匹配不上。
 *
 * 为什么用固定词表而不是让模型自由发挥：
 *   自由生成的标签会漂（这次写"午饭"，下次写"中饭"），词表一散就永远匹配不上。
 *   钉死之后，"今天吃什么"能稳定命中 吃饭 这一条。
 *
 * 加新标签：直接往这里加。整理员只允许用表里的词。
 */
export const TAGS = [
  '日常', '情绪', '身体', '睡眠', '吃药',
  '工作', '学习', '家人', '朋友', '社交',
  '爱好', '游戏', '影视', '音乐', '读书',
  '吃饭', '出行', '天气', '约定', '称呼', '未来',
];

/**
 * 标签的别称 —— 他嘴里不会说"常去的那家店"，他说"老地方"。
 *
 * 只用于**检索时的匹配**，不影响存进去的标签。
 * 没有这张表，"又去老地方了"就匹配不上记着 出行 的那条 ——
 * 而绕弯的说法正是最需要被认出来的时候。
 *
 * 克制一点：别塞太松的词（比如给 身体 加个"疼"），
 * 一个泛词会把一堆不相干的条目全捞进候选池。
 */
export const TAG_ALIASES = {
  身体: ['不舒服', '难受', '累', '疼'],
  睡眠: ['睡不着', '睡不好', '睡得浅', '失眠', '熬夜'],
  // 情绪给得宽一点，是有意的：
  //   那道闸是用来拦"她不请自来地翻旧账"的，不是用来让她在他绕着这个话题说的时候失忆的。
  //   他说"活着真没意思"，她一点反应都没有 —— 那比多想起来一次更糟。
  //   给宽了的代价是偶尔多捞一条进候选池，而候选池后面还有检索员过一遍。
  情绪: ['心情', '难受', '没劲', '没意思', '没意义', '活着', '图什么', '撑不住', '空落'],
  吃饭: ['胃口', '吃了'],
  学习: ['上课', '作业', '考试'],
  家人: ['爸妈', '父母', '我妈', '我爸'],
  出行: ['出门', '路上', '回来'],
};

const SCHEMA = `
pragma journal_mode = WAL;

create table if not exists messages (
  id          integer primary key autoincrement,
  session     text    not null,
  role        text    not null,
  content     text    not null,
  at          integer not null,
  archived    integer not null default 0,
  archived_at integer
);
create index if not exists idx_msg on messages(session, archived, id);

-- 会话状态（原来 JSON 里那几个零散字段）
create table if not exists sessions (
  session           text primary key,
  last_user_at      integer not null default 0,
  last_bot_at       integer not null default 0,
  proactive_pending integer not null default 0,
  proactive_today   integer not null default 0,
  proactive_day     text    not null default '',
  memory_up_to      integer not null default 0
);

-- 事实：关于他的稳定东西。一直带着，所以要短。
create table if not exists facts (
  id         integer primary key autoincrement,
  session    text    not null,
  topic      text    not null default '其他',
  body       text    not null,
  tags       text    not null default '',
  confidence text    not null default 'ok',   -- ok | unsure
  updated_at integer not null,
  active     integer not null default 1
);
create index if not exists idx_facts on facts(session, active);

-- 情景：发生过的事 + 她当时的感觉。平时不出现，触发了才想起来。
create table if not exists episodes (
  id          integer primary key autoincrement,
  session     text    not null,
  at          integer not null,              -- 事情发生的时间
  what        text    not null,              -- 发生了什么（一句，第三人称）
  tags        text    not null default '',   -- 逗号分隔，只能取自 TAGS
  his_state   text    not null default '',   -- 他当时什么状态
  her_feeling text    not null default '',   -- 她当时什么感觉 ← 活人感就靠这个
  weight      integer not null default 0,    -- 情绪重量 0-3，越大越重
  sensitive   integer not null default 0,    -- 1 = 情绪低谷那类，只允许话题命中，绝不主动浮出
  recalled_at integer not null default 0,    -- 上次被想起来是什么时候（防复读）
  created_at  integer not null
);
create index if not exists idx_ep on episodes(session, at);

-- 待续话题：他说过的、将来才会发生或还没说完的事。
-- 到了时候她去接上；问过一次就不再见天日（status='asked'），免得天天念叨同一件。
create table if not exists threads (
  id         integer primary key autoincrement,
  session    text    not null,
  what       text    not null,                -- 一句话：什么事
  tags       text    not null default '',
  due_at     integer not null default 0,      -- 大概该问的时候（毫秒，0 = 没定）
  status     text    not null default 'open', -- open | asked | done
  asked_at   integer not null default 0,
  created_at integer not null
);
create index if not exists idx_threads on threads(session, status, due_at);

-- 她自己的状态。facts 是"他是谁"，这张表是"她这几天什么样"。
-- 跨天连续 —— 不然她每天醒来都是从零开始，那不叫有想法，那叫失忆。
create table if not exists self_state (
  session    text primary key,
  mood       text not null default '',
  note       text not null default '',
  updated_at integer not null
);

-- 她自己的日子。一天一行：
--   plan        今天大概想怎么过（按日确定，不每轮变）
--   activity    她此刻在做什么（按小时换，重启不跳）
--   mood/cause  她自己的天气（可能和他无关）
-- self_state 是"这几天心里什么样"，这张表是"今天具体在过什么日子"。
create table if not exists her_day (
  session        text    not null,
  day            text    not null,
  plan           text    not null default '',
  activity       text    not null default '',
  activity_since integer not null default 0,
  body           text    not null default '',
  mood           text    not null default 'ok',   -- low | ok | good
  mood_cause     text    not null default '',
  updated_at     integer not null,
  primary key (session, day)
);

-- 她自己的日记。不是对话摘要，是"他不在时她想到的那部分"。
-- shareable=0 的只作为底色，不许她顺口讲出来。
create table if not exists her_diary (
  id         integer primary key autoincrement,
  session    text    not null,
  day        text    not null,
  at         integer not null,
  thought    text    not null,
  mood       text    not null default '',
  shareable  integer not null default 1,
  created_at integer not null
);
create index if not exists idx_diary on her_diary(session, day, id);
`;

export class Memory {
  constructor(dir, { keepRecent = KEEP_RECENT, dbFile = 'memory.db' } = {}) {
    this.dir = dir;
    this.keepRecent = keepRecent;
    fs.mkdirSync(dir, { recursive: true });

    // ':memory:' 原样透传 —— path.join 会把它拼成一个真文件路径
    this.file = dbFile === ':memory:' ? ':memory:' : path.join(dir, dbFile);
    this.db = new DatabaseSync(this.file);
    this.db.exec(SCHEMA);

    // 标签词表 —— 常驻内存，几百条情景也就是几十个标签，不值当每次查库
    this.#tags = this.#loadTags();
  }

  #tags;

  // ---------------------------------------------------------------- 底层

  #session(key) {
    this.db.prepare('insert or ignore into sessions(session) values (?)').run(key);
  }

  #loadTags() {
    const set = new Set(TAGS);
    // 词表是钉死的，但历史数据里可能有词表外的旧标签，一并认下来
    for (const r of this.db.prepare('select tags from episodes').all()) {
      for (const t of String(r.tags || '').split(',')) if (t.trim()) set.add(t.trim());
    }
    return set;
  }

  /** 给整理员用的：当前生效的事实（带 id，好让它原地更新） */
  currentFacts(key) {
    return this.db.prepare(
      `select id, topic, body, confidence, tags, updated_at from facts
        where session = ? and active = 1 order by topic, id`,
    ).all(key);
  }

  // ---------------------------------------------------------------- 兼容旧接口

  /** 会话状态。原来读 JSON，现在读 sessions 表。 */
  load(key) {
    this.#session(key);
    const r = this.db.prepare('select * from sessions where session = ?').get(key);
    return {
      lastUserAt: r.last_user_at,
      lastBotAt: r.last_bot_at,
      proactivePending: !!r.proactive_pending,
      proactiveToday: r.proactive_today,
      proactiveDay: r.proactive_day,
      memoryUpTo: r.memory_up_to,
    };
  }

  #set(key, col, val) {
    this.#session(key);
    this.db.prepare(`update sessions set ${col} = ? where session = ?`).run(val, key);
  }

  /** 追加一条消息。只写，不删 —— 裁剪靠归档，不靠丢弃。 */
  append(key, role, content) {
    const now = Date.now();
    this.#session(key);
    this.db.prepare(
      'insert into messages(session, role, content, at) values (?, ?, ?, ?)',
    ).run(key, role, content, now);

    if (role === 'user') {
      this.db.prepare(
        'update sessions set last_user_at = ?, proactive_pending = 0 where session = ?',
      ).run(now, key);   // 主人回话了，解除「不再追发」的锁
    } else {
      this.db.prepare('update sessions set last_bot_at = ? where session = ?').run(now, key);
    }

    return this.load(key);
  }

  /**
   * 给模型看的消息数组：还没归档的，取最近 keepRecent 条。
   *
   * **带上 `at`。** 单位毫秒。这是「隔夜当刚发生」的解药 ——
   * 库里每条消息一直有时间戳，只是从前到这里被剥掉了，模型拿到的是
   * 30 条没有时间的信息，看不出哪两条之间过了一夜。
   *
   * 注意 `at` 只是给 llm.mjs 判断断点用的，**不能原样进请求体**
   * （DeepSeek 不认 messages 里的多余字段）—— llm.mjs 拼数组时会剥掉。
   */
  context(key) {
    const rows = this.db.prepare(
      `select role, content, at from messages
        where session = ? and archived = 0
        order by id desc limit ?`,
    ).all(key, this.keepRecent);
    return rows.reverse().map(({ role, content, at }) => ({ role, content, at }));
  }

  /** 长期记忆：facts 渲染成的文本块，每轮都带上 */
  getMemory(key) {
    const rows = this.db.prepare(
      `select topic, body, confidence from facts
        where session = ? and active = 1
        order by topic, id`,
    ).all(key);
    if (!rows.length) return '';

    // 按主题分段。事实要短 —— 它是每一轮都在付钱的东西。
    const byTopic = new Map();
    for (const r of rows) {
      if (!byTopic.has(r.topic)) byTopic.set(r.topic, []);
      byTopic.get(r.topic).push(r.confidence === 'unsure' ? `${r.body}（拿不准）` : r.body);
    }
    return [...byTopic]
      .map(([topic, lines]) => `【${topic}】\n${lines.map((l) => `- ${l}`).join('\n')}`)
      .join('\n');
  }

  /**
   * 该总结了吗？该的话，把要总结的那批消息交出来。
   *
   * 注意是「借」不是「拿」—— 调用方总结成功后才 applySummary 归档。
   * 模型调用失败时这批消息原样留着，下次再试。宁可多留，不能丢。
   * （旧版这里是 slice 掉就没了，那正是「只记得今天下午」的原因。）
   */
  takeForSummary(key) {
    const { c } = this.db.prepare(
      'select count(*) c from messages where session = ? and archived = 0',
    ).get(key);
    const overflow = c - this.keepRecent;
    if (overflow < SUMMARY_BATCH) return null;

    // SUMMARY_BATCH 既当「够不够格触发」的阈值，也当**一次借多少条**的上限。
    //
    // 以前这里 limit 给的是 overflow（全部溢出），注释却写着「攒够 20 条总结一次」——
    // 一字之差，后果是溢出一大就把几百条一次性全交出去，被切成十几个 chunk，
    // 每个 chunk 都要整份重写 facts，输出直接顶爆 max_tokens 被截断
    // → 一条都不归档 → 下次更多 → 死锁。
    //
    // 现在一次只借最老的 20 条。归档顺序照样对：取的是最小 id 的这批，
    // lastId 就是它最后一条的 id，applySummary 的 `where id <= lastId` 正好只归档它们。
    const rows = this.db.prepare(
      `select id, role, content, at from messages
        where session = ? and archived = 0
        order by id limit ?`,
    ).all(key, Math.min(overflow, SUMMARY_BATCH));

    return {
      previous: this.currentFacts(key),
      messages: rows,               // 带 id 和 at，归档和定时间都要用
      count: rows.length,
      lastId: rows[rows.length - 1].id,
    };
  }

  /**
   * 总结完了：写进 facts / episodes，把被总结的消息**归档**。
   *
   * 归档 = 打标记，不进上下文，但永远留在库里。
   * 这样她"忘掉"的只是细节，原始对话还在 —— 以后想找回来还有得找。
   *
   * `facts` 收两种形状：
   *   · `{add, update, remove}` —— 增量（整理员现在走这条）
   *   · `[...]` —— 整份重写（旧口径，`tools/migrate-to-sqlite.mjs` 还在用）
   *
   * `threads`（`{add,done}`）和 `self`（`{mood,note}`）都是后加的，**可以不给** ——
   * 旧调用方（迁移工具）不传这两个字段，走默认值就是什么都不做。
   */
  applySummary(key, { facts = [], episodes = [], threads = {}, self: selfState, lastId, upTo }) {
    const now = Date.now();
    this.#session(key);

    this.db.exec('begin');
    try {
      this.#applyFacts(key, facts, now);

      // ---- 情景：只增不改。发生过的事就发生过了，不该被后来的总结覆盖掉。
      for (const e of episodes) {
        if (!e?.what) continue;
        this.db.prepare(
          `insert into episodes(session, at, what, tags, his_state, her_feeling, weight, sensitive, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          key, Number(e.at) || now, String(e.what).slice(0, 300),
          this.#cleanTags(e.tags), String(e.his_state || '').slice(0, 200),
          String(e.her_feeling || '').slice(0, 200),
          Math.max(0, Math.min(3, Number(e.weight) || 0)),
          e.sensitive ? 1 : 0, now,
        );
      }

      // ---- 待续的话头：只加不删（了结是打 asked/done，留痕）
      this.#applyThreads(key, threads, now);

      // ---- 她自己的状态
      this.#applySelfState(key, selfState, now);

      // ---- 归档（不是删除）
      this.db.prepare(
        'update messages set archived = 1, archived_at = ? where session = ? and id <= ?',
      ).run(now, key, lastId);
      this.db.prepare('update sessions set memory_up_to = ? where session = ?')
        .run(upTo ?? now, key);

      this.#tags = this.#loadTags();
      this.db.exec('commit');
    } catch (e) {
      this.db.exec('rollback');
      throw e;
    }

    return this.load(key);
  }

  /**
   * 写事实。两种口径（见 applySummary 的说明）。
   *
   * 增量口径比整份重写强在哪：整理员**漏抄**一条，不会再被当成"这条不成立了"
   * 而误淘汰。整份重写那套里，"没提到"和"要删掉"是一个意思 —— 模型打个盹，
   * 事实就没了。现在想删必须显式写进 remove。
   *
   * 退场一律是打 `active = 0`（不删，留痕）。
   */
  #applyFacts(key, facts, now) {
    const existing = new Map(this.currentFacts(key).map((f) => [f.id, f]));

    // 有 id 且库里真有 → 原位改；否则插新的。缺字段的按原值补，别把没提到的清成空。
    const upsert = (f) => {
      if (!f) return null;
      const id = f.id != null ? Number(f.id) : null;
      const old = id != null && existing.has(id) ? existing.get(id) : null;
      const body = f.body ?? old?.body;
      if (!body) return null;

      const topic = f.topic || old?.topic || '其他';
      const confidence = f.confidence || old?.confidence || 'ok';
      const tags = f.tags === undefined ? (old?.tags || '') : this.#cleanTags(f.tags);

      if (old) {
        const changed = old.body !== body || old.topic !== topic
          || old.confidence !== confidence || (old.tags || '') !== tags;
        // 内容没变就别动 updated_at —— 否则「这条是什么时候知道的」会一直往后漂
        this.db.prepare(
          'update facts set topic = ?, body = ?, tags = ?, confidence = ?, updated_at = ? where id = ?',
        ).run(topic, body, tags, confidence, changed ? now : old.updated_at, id);
        return id;
      }
      const r = this.db.prepare(
        `insert into facts(session, topic, body, tags, confidence, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
      ).run(key, topic, body, tags, confidence, now);
      return Number(r.lastInsertRowid);
    };

    const retire = (id) => {
      if (existing.has(id)) {
        this.db.prepare('update facts set active = 0, updated_at = ? where id = ?').run(now, id);
      }
    };

    // 旧口径：整份重写 —— 整理员这次没提的旧事实一律退场
    if (Array.isArray(facts)) {
      const keep = new Set();
      for (const f of facts) {
        const id = upsert(f);
        if (id != null) keep.add(id);
      }
      for (const id of existing.keys()) if (!keep.has(id)) retire(id);
      return;
    }

    // 增量口径：只动它点名的那几条，其余原样留着
    for (const id of facts.remove || []) retire(Number(id));
    for (const f of facts.update || []) upsert(f);
    for (const f of facts.add || []) upsert(f);
  }

  /**
   * 写待续的话头。
   *
   * 只接受 add / done 两个篮子：
   *   · 不做 remove —— 「他那天心情不好」这种事没有"作废"的语义，
   *     要么问了（asked）、要么了结了（done），都是留痕的状态迁移。
   *   · **同一句话不重复记** —— 整理员在分批里很容易把同一件事报两遍
   *     （分批导入时就是分十几个批次喂的），而这里没有 id 可对，
   *     所以拿 what 原文比一下。反正 what 是它自己写的一行字，够稳。
   */
  #applyThreads(key, { add = [], done = [] } = {}, now) {
    const dup = this.db.prepare(
      `select id from threads
        where session = ? and status in ('open','asked') and what = ?`,
    );
    for (const t of add) {
      if (!t?.what) continue;
      const what = String(t.what).slice(0, 200);
      if (dup.get(key, what)) continue;
      this.db.prepare(
        `insert into threads(session, what, tags, due_at, created_at) values (?, ?, ?, ?, ?)`,
      ).run(key, what, this.#cleanTags(t.tags), Number(t.due_at) || 0, now);
    }
    for (const id of done) {
      this.db.prepare(`update threads set status = 'done' where session = ? and id = ?`)
        .run(key, Number(id));
    }
  }

  /**
   * 写她自己的状态。**整份重写**（跟整份重写的 facts 不同，这个只有两句话，
   * 不存在被 max_tokens 切断的风险）。
   *
   * 空的一次直接跳过：整理员这批没话说时不该把她之前的状态抹成白纸 ——
   * 那等于她每隔一会儿就失忆一次。
   */
  #applySelfState(key, s, now) {
    const mood = String(s?.mood || '').trim().slice(0, 200);
    const note = String(s?.note || '').trim().slice(0, 300);
    if (!mood && !note) return;
    this.db.prepare(
      `insert into self_state(session, mood, note, updated_at) values (?, ?, ?, ?)
       on conflict(session) do update set mood = excluded.mood, note = excluded.note,
                                          updated_at = excluded.updated_at`,
    ).run(key, mood, note, now);
  }

  /** 标签只留词表里的，去掉重复和空白 */
  #cleanTags(raw) {
    const out = [];
    for (const t of String(raw || '').split(/[,，、\s]+/)) {
      const v = t.trim();
      if (v && this.#tags.has(v) && !out.includes(v)) out.push(v);
    }
    return out.join(',');
  }

  // ---------------------------------------------------------------- 待续的话头

  /** 还给开着的（含已问未答的）—— 整理员靠这个避免记重、并判断哪条已经有结果了 */
  openThreads(key) {
    return this.db.prepare(
      `select id, what, tags, due_at from threads
        where session = ? and status in ('open', 'asked') order by due_at, id`,
    ).all(key);
  }

  /**
   * 主动开口时该接上的那一条。
   *
   * 只挑**到点了**（due_at <= now）或者**本来就没定时间**的（due_at = 0）。
   * 有日子还没到的不动 —— 那正是用户抱怨的那件事本身：
   * 他下周三才考试，今天不该问她"考得怎么样"。
   *
   * 排序：定了日子且到点的排前面（越早到越优先），没定日子的按记录顺序垫后。
   */
  pickThread(key, now = Date.now()) {
    return this.db.prepare(
      `select id, what, due_at from threads
        where session = ? and status = 'open' and (due_at = 0 or due_at <= ?)
        order by (due_at = 0), due_at, id limit 1`,
    ).get(key, now) || null;
  }

  /** 问过了。留痕，不再主动提 —— 这就是「问过一次就不念叨」那道闸。 */
  markThreadAsked(id, now = Date.now()) {
    this.db.prepare(`update threads set status = 'asked', asked_at = ? where id = ?`).run(now, id);
  }

  /**
   * 收摊：定了日子、过了很久还没问上的，别再挂着。
   *
   * asked 的也算 —— 他要是压根没回那一句，这条就永远卡在 asked 里占着位置，
   * 而它已经没有任何用了。留着只会让"她还惦记着的事"越积越假。
   */
  expireThreads(key, now = Date.now()) {
    return this.db.prepare(
      `update threads set status = 'done'
        where session = ? and status in ('open', 'asked')
          and due_at > 0 and due_at < ?`,
    ).run(key, now - 30 * 86400_000).changes;
  }

  // ---------------------------------------------------------------- 她自己的状态

  /** @returns {{mood:string,note:string,updatedAt:number}|null} */
  getSelfState(key) {
    const r = this.db.prepare(
      'select mood, note, updated_at from self_state where session = ?',
    ).get(key);
    return r ? { mood: r.mood, note: r.note, updatedAt: r.updated_at } : null;
  }

  // ---------------------------------------------------------------- 她自己的日子

  /**
   * 她今天在过什么日子。
   *
   * `touch = true` 时会把「此刻在做什么」写回 her_day —— 正式回复和主动发言走这条，
   * 这样下一轮不会又换一件事。调试台传 false，只算不写。
   *
   * 活动/身体按小时换，天气和打算按本地日确定；两者都不依赖模型。
   */
  getLife(key, now = Date.now(), { touch = true } = {}) {
    const day = localDay(new Date(now));
    const weather = dailyWeather(key, day);
    const row = this.db.prepare(
      'select * from her_day where session = ? and day = ?',
    ).get(key, day);

    const slot = activityAt(key, now);
    const plan = row?.plan || weather.plan;
    const mood = row?.mood || weather.mood;
    const moodCause = row?.mood_cause || weather.cause;

    if (touch) {
      this.db.prepare(
        `insert into her_day(session, day, plan, activity, activity_since, body, mood, mood_cause, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(session, day) do update set
           plan = excluded.plan,
           activity = excluded.activity,
           activity_since = excluded.activity_since,
           body = excluded.body,
           mood = excluded.mood,
           mood_cause = excluded.mood_cause,
           updated_at = excluded.updated_at`,
      ).run(key, day, plan, slot.activity, slot.since, slot.body, mood, moodCause, now);
    }

    return {
      day,
      plan,
      activity: slot.activity,
      activitySince: slot.since,
      body: slot.body,
      mood,
      moodCause,
      diary: this.latestDiary(key, now),
      updatedAt: now,
    };
  }

  /** 最近几天的一篇日记。给提示词用，也用来防写重复。 */
  latestDiary(key, now = Date.now()) {
    const r = this.db.prepare(
      `select id, day, at, thought, mood, shareable from her_diary
        where session = ? and at >= ? and at <= ?
        order by at desc, id desc limit 1`,
    ).get(key, now - 3 * 86400_000, now + 60_000);
    return r ? {
      id: r.id,
      day: r.day,
      at: r.at,
      thought: r.thought,
      mood: r.mood,
      shareable: !!r.shareable,
    } : null;
  }

  /**
   * 该不该写日记？该的话，把材料交出来。
   *
   * 门槛故意不低：
   *   · 同一天最多 2 篇，两篇之间至少隔 4 小时；
   *   · 今天至少有 2 条他说的话、总共 6 条消息；
   *   · 白天要聊得更多（16 条）才写，傍晚以后 6 条就够 ——
   *     日记更像晚上回头看一眼，不是每聊两句就交作业。
   *
   * 返回 null 表示这次不写，调用方什么都不用做。
   */
  diaryJob(key, now = Date.now()) {
    const day = localDay(new Date(now));
    const today = this.db.prepare(
      'select count(*) c from her_diary where session = ? and day = ?',
    ).get(key, day).c;
    if (today >= 2) return null;

    const last = this.db.prepare(
      'select at from her_diary where session = ? order by at desc limit 1',
    ).get(key);
    if (last && now - last.at < 4 * 3_600_000) return null;

    // 不筛 archived：日记要看的是「今天一整天」，不是还没归档的那 30 条。
    // 主动发出时插的那行 `（主动发出）` 是给上下文用的标记，不是她说的话，滤掉。
    const messages = this.db.prepare(
      `select role, content, at from messages
        where session = ? and at >= ? and at <= ?
        order by id`,
    ).all(key, startOfDay(now), now).filter((m) => m.content !== '（主动发出）');

    const userCount = messages.filter((m) => m.role === 'user').length;
    if (userCount < 2 || messages.length < 6) return null;
    if (new Date(now).getHours() < 18 && messages.length < 16) return null;

    return {
      day,
      now,
      messages: messages.slice(-30),
      life: this.getLife(key, now, { touch: false }),
      selfState: this.getSelfState(key),
      lastDiary: this.latestDiary(key, now),
    };
  }

  /** 写一篇日记。同一天同一句话不重复写；一天最多 2 篇。 */
  saveDiary(key, { day, at = Date.now(), thought, mood = '', shareable = true } = {}) {
    const dayKey = day || localDay(new Date(at));
    const text = String(thought || '').trim().slice(0, 800);
    if (!text) return null;

    const dup = this.db.prepare(
      'select id from her_diary where session = ? and day = ? and thought = ?',
    ).get(key, dayKey, text);
    if (dup) return null;

    const count = this.db.prepare(
      'select count(*) c from her_diary where session = ? and day = ?',
    ).get(key, dayKey).c;
    if (count >= 2) return null;

    const r = this.db.prepare(
      `insert into her_diary(session, day, at, thought, mood, shareable, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(key, dayKey, at, text, String(mood || '').slice(0, 20), shareable ? 1 : 0, Date.now());

    return {
      id: Number(r.lastInsertRowid),
      day: dayKey,
      at,
      thought: text,
      mood,
      shareable: !!shareable,
    };
  }

  // ---------------------------------------------------------------- 主动发言

  markProactive(key) {
    this.#session(key);
    // localDay 不是 toISOString：后者是 UTC 日，在 UTC+8 要到本地早上 8 点才翻篇，
    // 和免打扰窗口（本地 1:00–8:00）刚好错开，"每天最多 3 条"就成了按晚 8 点到早 8 点计。
    const today = localDay();
    const s = this.load(key);
    const today0 = s.proactiveDay === today ? s.proactiveToday : 0;
    this.db.prepare(
      `update sessions set proactive_day = ?, proactive_today = ?, proactive_pending = 1,
                           last_bot_at = ? where session = ?`,
    ).run(today, today0 + 1, Date.now(), key);
    this.db.prepare(
      'insert into messages(session, role, content, at) values (?, ?, ?, ?)',
    ).run(key, 'assistant', '（主动发出）', Date.now());
    return today0 + 1;
  }

  // ---------------------------------------------------------------- 检索

  /**
   * 她"想起来"几件事。
   *
   * 三级，从便宜到贵：
   *   ① 标签命中 —— 他这句话里出现了某个标签词（"咖啡"）。精确、免费，主力。
   *   ② 情绪触发 —— 他这句听着低落，就把重的、不敏感的那些捞出来。
   *      现在这层完全没发挥：旧版把"什么时候容易崩"埋在散文里，永远不会被触发。
   *   ③ 候选池 —— 交给 LLM 记忆检索员去挑（见 recall.mjs），语义匹配。
   *
   * sensitive 的条目只走 ①：他主动提了才接，绝不因为"他心情不好"就自己浮出来。
   *
   * @returns {Array} 候选情景，按相关度排序。真正给她看之前还要过一遍检索员。
   */
  recall(key, text, { limit = 8, now = Date.now() } = {}) {
    const msg = String(text || '');
    // 大小写不敏感 —— 英文标签不该因为大小写被漏掉。
    // 别称也算命中：他说"老地方"，记的是"常去的那家店"。
    const lowMsg = msg.toLowerCase();
    const hitTags = [...this.#tags].filter((t) => {
      if (lowMsg.includes(t.toLowerCase())) return true;
      return (TAG_ALIASES[t] || []).some((a) => lowMsg.includes(a.toLowerCase()));
    });

    const rows = this.db.prepare(
      `select id, at, what, tags, his_state, her_feeling, weight, sensitive, recalled_at
         from episodes where session = ? order by at desc limit 400`,
    ).all(key);
    if (!rows.length) return [];

    // 他这话是不是低落 —— 不用模型，几个词够了。
    //
    // 注意这里**刻意不放**「想死」这类词：那属于危机判断，是另一件事。
    // 这个正则只回答「他现在心情沉不沉」，用来决定"要不要多想起点旧事"，
    // 不触发任何别的行为。别往这里加危机词，那会让它看起来像关键词检测。
    const low = /难受|撑不住|崩溃|累|烦|没意思|空虚|空落|疼|睡不着|失眠|一个人|孤独|压力|不想动/.test(msg);
    // 深夜也容易想起旧事
    const hour = new Date(now).getHours();
    const night = hour >= 0 && hour < 5;

    const scored = rows.map((r) => {
      const tags = String(r.tags || '').split(',').filter(Boolean);
      const byTag = tags.some((t) => hitTags.includes(t));

      // **敏感条目只允许话题命中** —— 他主动提了才接。
      // 这道闸放在最前面：不依赖模型判断，也不看他心情好不好。
      if (r.sensitive && !byTag) return null;

      let score = byTag ? 10 : 0;

      // ② 情绪触发：只有**分量够重**的才配自己浮出来。
      //    以前这里不看 weight，结果他说一句"有点累"，凡是有点分量的旧事
      //    全冒出来了 —— 那不是想起，那是倒记忆垃圾。weight >= 2 才够格。
      if (!byTag && (low || night) && r.weight >= 2) score += r.weight * 2;
      if (!byTag && score === 0) return null;

      // 最近想起来过的降权，别让她反复提同一件事
      const since = now - (r.recalled_at || 0);
      if (since < 6 * 3600_000) score -= 8;
      else if (since < 24 * 3600_000) score -= 4;

      // 同一件事越久没想起来，越容易冒出来一点点
      const ageDays = (now - r.at) / 86400_000;
      if (score > 0) score += Math.min(3, ageDays / 10);

      return { ...r, tags, score, byTag };
    }).filter(Boolean);

    const byScore = (a, b) => b.score - a.score || b.at - a.at;
    const tagHits = scored.filter((r) => r.byTag).sort(byScore);
    const moodHits = scored.filter((r) => !r.byTag && r.score > 0).sort(byScore);

    // 话题打中的都要（那是他自己说到的）；情绪捞的**最多 2 件**。
    // 宁少勿多 —— 想起三件事塞给他，比一件不想更假。
    return [...tagHits, ...moodHits.slice(0, 2)].slice(0, limit);
  }

  /** 记一笔"这些事被想起来了"，防复读 */
  markRecalled(ids, now = Date.now()) {
    const st = this.db.prepare('update episodes set recalled_at = ? where id = ?');
    for (const id of ids) st.run(now, id);
  }

  // ---------------------------------------------------------------- 观察用

  stats(key) {
    const one = (sql, ...a) => this.db.prepare(sql).get(...a);
    return {
      db: this.file,
      dbKB: this.file === ':memory:' ? 0 : Math.round(fs.statSync(this.file).size / 1024),
      active: one('select count(*) c from messages where session = ? and archived = 0', key).c,
      archived: one('select count(*) c from messages where session = ? and archived = 1', key).c,
      facts: one('select count(*) c from facts where session = ? and active = 1', key).c,
      factsOff: one('select count(*) c from facts where session = ? and active = 0', key).c,
      episodes: one('select count(*) c from episodes where session = ?', key).c,
      sensitive: one('select count(*) c from episodes where session = ? and sensitive = 1', key).c,
      threads: one("select count(*) c from threads where session = ? and status = 'open'", key).c,
      threadsAsked: one("select count(*) c from threads where session = ? and status = 'asked'", key).c,
      selfState: this.getSelfState(key),
      memoryChars: this.getMemory(key).length,
    };
  }

  close() { this.db.close(); }
}
