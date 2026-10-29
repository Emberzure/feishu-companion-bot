// 时间说成人话
//
// 只做一件事：把毫秒戳换算成她读得懂的中文时间，拼成一块 system 文本。
//
// **模型自己是没有钟的。** 不把这段喂进去，她就永远以为现在还是上一次
// 对话的那一刻 —— 「隔夜了还问睡没睡」就是这么来的。
//
// 全部函数都**接受注入的 `now`**，不自己去读 Date.now()：这样 ./try --at
// 能假装现在是凌晨三点，把深夜和早上两种表现摆在一起比。
//
// 单位统一是**毫秒**，和库里 messages.at / sessions.last_user_at 一致。

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');

/**
 * 本地日的 YYYY-MM-DD。
 *
 * ★ **不要用 `toISOString().slice(0,10)`** —— 那个给的是 UTC 日期，在 UTC+8
 *   要到本地早上 8 点才翻篇，正好和免打扰窗口（本地 1:00–8:00）错开一整天，
 *   于是"每天最多主动 3 条"实际按「早 8 点到次日早 8 点」在计。
 */
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 时段词。按中国人说话的习惯切，不是按钟点均分。 */
export function partOfDay(d) {
  const h = d.getHours();
  if (h < 5) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h === 12) return '中午';
  if (h < 18) return '下午';
  if (h < 20) return '傍晚';
  if (h < 23) return '晚上';
  return '深夜';
}

/**
 * 12 小时制的钟点，配着上面的时段词读。
 *
 * 因为前缀已经把上午下午说清楚了，"下午 15:20"就重复且不像人话，
 * "下午 3:20"才是。0 点写成 12 —— 中国人说"凌晨十二点四十"，
 * 不说"凌晨零点四十"。
 */
function hhmm(d) {
  const h = d.getHours();
  const show = h === 0 ? 12 : (h >= 13 ? h - 12 : h);
  return `${show}:${pad(d.getMinutes())}`;
}

/**
 * 差几个**本地日**（今天=0，昨天=1…）。
 * 按日历天算，不按"差够 24 小时"算 —— 昨晚 23:00 到今早 8:00 只隔 9 小时，
 * 但那是"昨天"，不是"今天早些时候"。
 */
export function dayDiff(at, now = Date.now()) {
  const a = new Date(at);
  const b = new Date(now);
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86400_000);
}

/**
 * 「今天早上 8:33」/「昨晚 11:10」/「前天下午 3:20」/「10月3日晚上 9:05」
 *
 * 不说"昨天晚上 23:10" —— 中国人说昨晚/今早，不说"昨天晚上十一点十分"。
 * 也不报年份：一报年份立刻变成在念档案。
 */
export function clockish(at, now = Date.now()) {
  const d = new Date(at);
  const hm = hhmm(d);
  const part = partOfDay(d);
  const diff = dayDiff(at, now);

  if (diff <= 0) return `今天${part} ${hm}`;
  if (diff === 1) return (part === '晚上' || part === '深夜')
    ? `昨晚 ${hm}`
    : `昨天${part} ${hm}`;
  if (diff === 2) return `前天${part} ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日${part} ${hm}`;
}

/** 「7 小时前」/「40 分钟前」/「刚刚」。给"距离他上次说话多久"用。 */
export function ago(at, now = Date.now()) {
  const mins = Math.round((now - at) / 60_000);
  if (mins <= 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = mins / 60;
  if (hrs < 1.75) return '一个多小时前';
  if (hrs < 24) return `${Math.round(hrs)} 小时前`;
  return `${Math.round(hrs / 24)} 天前`;
}

/** 一段停顿有多久，用说得出口的粒度（不报"9 小时 37 分"）。 */
export function gapWords(ms) {
  const hrs = ms / 3_600_000;
  if (hrs < 2) return '一个多小时';
  if (hrs < 24) return `${Math.round(hrs)} 小时`;
  const d = Math.round(hrs / 24);
  return d <= 1 ? '一天' : `${d} 天`;
}

/**
 * 主入口：拼出每轮都塞给她的【现在】。
 *
 * @param {number} now 毫秒
 * @param {{lastUserAt?:number, lastBotAt?:number}} opts 从 sessions 表读的
 * @returns {string} 一段可以直接当 system 消息用的文本
 */
export function nowBlock(now = Date.now(), { lastUserAt = 0, lastBotAt = 0 } = {}) {
  const d = new Date(now);
  const lines = [
    '【现在】',
    `现在是 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 `
      + `${WEEK[d.getDay()]} ${partOfDay(d)} ${hhmm(d)}。`,
  ];

  // 只在他真说过话时才提 —— 第一次聊天时 lastUserAt 是 0，不编。
  if (lastUserAt) {
    lines.push(`他上一次说话是${clockish(lastUserAt, now)}，${ago(lastUserAt, now)}。`);
  }
  if (lastBotAt) {
    lines.push(`你上一次说话是${clockish(lastBotAt, now)}。`);
  }

  lines.push(
    '',
    '上面这些是给你定时间用的，不是让你说出来的 ——',
    '不要报时间，不要写"现在是几点"，你只是知道。',
    '隔了很久才接上话时，别把上一轮的事当成刚发生的：',
    '他可能刚醒、可能在忙、可能在路上、也可能已经睡了。',
  );
  return lines.join('\n');
}
