// 记忆（SQLite）。三层：
//   messages  —— 原样的对话。永不删除，浓缩过的只是打个 archived 标记。
//   facts     —— 关于他的稳定事实。每轮都带，所以要短。
//   episodes  —— 发生过的事 + 角色当时的感受。被戳到才进上下文。
//
// 检索不走数据库全文索引：SQLite 的 unicode61 不认中文、trigram 只认完全相同的
// 三字串、icu 没编译进 node 自带的版本 —— 三条路都堵死（详见 docs/架构说明.md）。
// 所以靠「受控标签词表」（见 TAGS）+ 可选的 LLM 检索员做中文语义匹配。
//
// 这个库只增不删：archived 只是个标记，原文永远在。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 短期记忆保留多少条（不归档、原样进上下文）
const KEEP_RECENT = 30;
// 攒够这么多条溢出才总结一次 —— 每条消息都总结太费钱
const SUMMARY_BATCH = 20;

/**
 * 受控标签词表 —— 整套检索的地基。
 *
 * 整理员打标签、检索时匹配，两边共用同一张表。
 * 必须钉死：让模型自由发挥的话它会漂（这次写"咖啡"、下次写"拿铁"），
 * 词表一散就永远匹配不上。
 *
 * 这是一份示例词表，换成你和角色之间真实会聊到的话题。
 * 缺了的话题，那类事就永远想不起来。
 */
export const TAGS = [
  '日常', '情绪', '身体', '睡眠', '吃药',
  '工作', '学习', '家人', '朋友', '社交',
  '爱好', '游戏', '影视', '音乐', '读书',
  '吃饭', '出行', '天气', '约定', '称呼', '未来',
];

/**
 * 标签别称：他嘴里不会说"常去的那家店"，他说"老地方"。
 * 只用于检索匹配，不影响存进去的标签。
 *
 * 别称太泛会把不相干的条目全捞进候选池 —— 比如给 出行 挂一个"去"就不行。
 */
export const TAG_ALIASES = {
  身体: ['不舒服', '难受', '累', '疼'],
  睡眠: ['睡不着', '睡不好', '睡得浅', '失眠', '熬夜'],
  // 情绪和孤独给得宽，是有意的：他情绪明显不对时角色一点反应都没有，
  // 比多想起来一次更糟。多捞一条的代价由后面的检索员兜着。
  情绪: ['心情', '难受', '没劲', '没意思', '没意义', '撑不住', '空落'],
  崩溃: ['崩了', '撑不下去', '扛不住'],
  孤独: ['一个人', '没人说话', '没人', '没人在'],
  吃饭: ['胃口', '吃了'],
  学习: ['上课', '作业', '考试'],
  家人: ['爸妈', '父母'],
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

-- 情景：发生过的事 + 角色当时的感觉。平时不出现，触发了才想起来。
create table if not exists episodes (
  id          integer primary key autoincrement,
  session     text    not null,
  at          integer not null,              -- 事情发生的时间
  what        text    not null,              -- 发生了什么（一句，第三人称）
  tags        text    not null default '',   -- 逗号分隔，只能取自 TAGS
  his_state   text    not null default '',   -- 他当时什么状态
  her_feeling text    not null default '',   -- 角色当时什么感觉 ← 活人感就靠这个
  weight      integer not null default 0,    -- 情绪重量 0-3，越大越重
  sensitive   integer not null default 0,    -- 1 = 情绪低谷那类，只允许话题命中，绝不主动浮出
  recalled_at integer not null default 0,    -- 上次被想起来是什么时候（防复读）
  created_at  integer not null
);
create index if not exists idx_ep on episodes(session, at);
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

  /** 给模型看的消息数组：还没归档的，取最近 keepRecent 条 */
  context(key) {
    const rows = this.db.prepare(
      `select role, content from messages
        where session = ? and archived = 0
        order by id desc limit ?`,
    ).all(key, this.keepRecent);
    return rows.reverse().map(({ role, content }) => ({ role, content }));
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
   * 该总结了吗？该的话把要总结的那批消息交出来。
   * 注意是「借」不是「拿」—— 总结成功后才 applySummary 归档。
   * 模型调用失败时这批原样留着下次再试。宁可多留，不能丢。
   */
  takeForSummary(key) {
    const { c } = this.db.prepare(
      'select count(*) c from messages where session = ? and archived = 0',
    ).get(key);
    const overflow = c - this.keepRecent;
    if (overflow < SUMMARY_BATCH) return null;

    const rows = this.db.prepare(
      `select id, role, content, at from messages
        where session = ? and archived = 0
        order by id limit ?`,
    ).all(key, overflow);

    return {
      previous: this.currentFacts(key),
      messages: rows,               // 带 id 和 at，归档和定时间都要用
      count: rows.length,
      lastId: rows[rows.length - 1].id,
    };
  }

  /**
   * 总结完了：写进 facts / episodes，把被总结的消息归档。
   * 归档 = 打标记，不进上下文，但永远留在库里。
   */
  applySummary(key, { facts = [], episodes = [], lastId, upTo }) {
    const now = Date.now();
    this.#session(key);

    this.db.exec('begin');
    try {
      // ---- 事实：整份替换，但带 id 的原位更新，updated_at 只在内容真的变了时才动
      const keep = new Set();
      const existing = new Map(this.currentFacts(key).map((f) => [f.id, f]));
      for (const f of facts) {
        if (!f?.body) continue;
        const tags = this.#cleanTags(f.tags);
        if (f.id && existing.has(Number(f.id))) {
          const old = existing.get(Number(f.id));
          // 内容没变就别动 updated_at —— 否则「这条是什么时候知道的」会一直往后漂
          const changed = old.body !== f.body || old.topic !== f.topic
            || old.confidence !== (f.confidence || 'ok');
          this.db.prepare(
            'update facts set topic = ?, body = ?, tags = ?, confidence = ?, updated_at = ? where id = ?',
          ).run(f.topic || old.topic || '其他', f.body, tags, f.confidence || 'ok',
                changed ? now : old.updated_at, Number(f.id));
          keep.add(Number(f.id));
        } else {
          const r = this.db.prepare(
            `insert into facts(session, topic, body, tags, confidence, updated_at)
             values (?, ?, ?, ?, ?, ?)`,
          ).run(key, f.topic || '其他', f.body, tags, f.confidence || 'ok', now);
          keep.add(Number(r.lastInsertRowid));
        }
      }
      // 整理员这次没再提的事实 —— 退场（不删，留痕）
      for (const id of existing.keys()) {
        if (!keep.has(id)) {
          this.db.prepare('update facts set active = 0, updated_at = ? where id = ?').run(now, id);
        }
      }

      // ---- 情景：只增不改（发生过的事不该被后来的总结覆盖）
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

  /** 标签只留词表里的，去掉重复和空白 */
  #cleanTags(raw) {
    const out = [];
    for (const t of String(raw || '').split(/[,，、\s]+/)) {
      const v = t.trim();
      if (v && this.#tags.has(v) && !out.includes(v)) out.push(v);
    }
    return out.join(',');
  }

  // ---------------------------------------------------------------- 主动发言

  markProactive(key) {
    this.#session(key);
    const today = new Date().toISOString().slice(0, 10);
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
   * 角色"想起来"几件事。三级：
   *   ① 标签命中 —— 他这句话里出现了标签词。精确、免费，主力。
   *   ② 情绪触发 —— 他这句听着低落，捞分量重的那些出来。
   *   ③ 候选池 —— 交给 LLM 检索员挑（见 recall.mjs）。
   *
   * sensitive 的条目只走 ①：他主动提了才接，绝不因为他心情不好就自己浮出来。
   *
   * @returns {Array} 候选情景，按相关度排序。给角色看之前还要过一遍检索员。
   */
  recall(key, text, { limit = 8, now = Date.now() } = {}) {
    const msg = String(text || '');
    // 大小写不敏感；别称也算命中（他说"老地方"，记的是"常去的那家店"）。
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

    // 他这话低不低落 —— 几个词够了，不用模型。
    // 刻意不放危机词（「想死」这类）：那属于另一件事，
    // 这里只决定"要不要多想起点旧事"，别让它看起来像关键词检测。
    const low = /难受|撑不住|崩溃|累|烦|没意思|空虚|空落|疼|睡不着|失眠|一个人|孤独|压力|不想动/.test(msg);
    // 深夜也容易想起旧事
    const hour = new Date(now).getHours();
    const night = hour >= 0 && hour < 5;

    const scored = rows.map((r) => {
      const tags = String(r.tags || '').split(',').filter(Boolean);
      const byTag = tags.some((t) => hitTags.includes(t));

      // 敏感条目只允许话题命中：他主动提了才接，不看他心情好不好。
      if (r.sensitive && !byTag) return null;

      let score = byTag ? 10 : 0;

      // ② 情绪触发：只看 weight >= 2 的。否则他说一句"有点累"，
      //    凡是有点分量的旧事全冒出来 —— 那不是想起，是倒记忆垃圾。
      if (!byTag && (low || night) && r.weight >= 2) score += r.weight * 2;
      if (!byTag && score === 0) return null;

      // 最近想起来过的降权，别让角色反复提同一件事
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

    // 话题打中的都要；情绪捞的最多 2 件 —— 想起来三件事塞给他，比一件不想更假。
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
      memoryChars: this.getMemory(key).length,
    };
  }

  close() { this.db.close(); }
}
