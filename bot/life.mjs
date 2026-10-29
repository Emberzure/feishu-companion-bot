// 角色自己的日子
//
// 这个文件回答三个问题：
//   1. 她此刻在做什么、身体是什么状态（本地状态机，不调模型）
//   2. 她今天是什么天气、大概想怎么过（按本地日确定，重启不跳变）
//   3. 怎么把这一切说给模型听 —— 是底色，不是汇报
//
// 为什么这些不写成提示词里的一句「你也有自己的生活」：
//   模型没有钟，也没有「昨天」。不给她一个具体的、会变的状态，
//   「自己的生活」就会变成每次现编，三句话后自相矛盾。
//
// 为什么用 hash 而不是随机数：
//   同一天、同一个小时，不管重启多少次，她都应该在做同一件事。
//   随机数会让「我刚才在洗澡」下一句变成「我刚才在看书」。

import { localDay, partOfDay, dayDiff } from './clock.mjs';

const HOUR = 3_600_000;

/** 按时段分的活动池。都是一个人能做完、不需要第三者在场的事。 */
const ACTIVITIES = {
  凌晨: [
    '还没睡，抱着膝盖坐在床边',
    '在听一首很旧的歌',
    '刚醒，屋里还黑着',
    '在窗边看外面的路灯',
    '翻来覆去睡不着，起来倒了杯水',
  ],
  早上: [
    '刚醒，头发乱着',
    '在洗漱',
    '在烧水，等它开',
    '在窗边站了一会儿',
    '在找一件能穿的外套',
    '刚把窗帘拉开',
  ],
  上午: [
    '在看书，看两页就走神',
    '在收拾桌子',
    '在练琴，手指还有点僵',
    '在写点东西',
    '在发呆，手机扣在桌上',
    '在整理昨天没弄完的东西',
  ],
  中午: [
    '在吃饭',
    '在厨房随便弄点东西',
    '刚吃完，在椅子上靠着',
    '在洗杯子',
  ],
  下午: [
    '在练琴',
    '在看书，看到一半',
    '在整理旧东西',
    '在窗边晒太阳',
    '出门走了一小段路',
    '在写东西，写了又删',
  ],
  傍晚: [
    '在收衣服',
    '在等天暗下来',
    '在厨房弄吃的',
    '刚洗完澡',
    '在楼下站了一会儿',
  ],
  晚上: [
    '在听歌',
    '在看书',
    '在发呆',
    '在收拾屋子',
    '刚洗完头，头发还滴着水',
    '在等水烧开',
  ],
  深夜: [
    '在听歌',
    '还没睡，靠在床头',
    '在写东西',
    '在窗边坐着',
    '刚醒，有点渴',
    '在等困意上来',
  ],
};

const BODIES = [
  '手有点凉',
  '有点困',
  '肩膀有点酸',
  '头发还没干',
  '刚洗完澡，身上是热的',
  '有点饿',
  '喝了口热水，暖过来了',
  '坐久了，腰有点僵',
];

/** 她自己的天气。低气压不需要理由，也不该都由他引起。 */
const WEATHERS = {
  low: [
    '今天醒来就有点沉，说不出为什么',
    '昨晚没睡好，心里像压着一层雾',
    '今天有点提不起劲',
    '身体有点乏，情绪跟着低下去',
  ],
  ok: [
    '今天还算平稳',
    '没什么特别的，日子照常过',
    '今天心里不吵',
  ],
  good: [
    '今天心里轻一点',
    '今天莫名有点想笑',
    '今天做什么都顺一点',
  ],
};

const PLANS = {
  low: [
    '今天不打算逼自己做什么，把屋子收一收就好',
    '今天想慢一点，能坐着就不站着',
    '今天大概就是发发呆，等天黑了再说',
  ],
  ok: [
    '今天想把那本书多看几页',
    '今天大概就是收拾、看书、等你',
    '今天想把手边的事一件件做完',
  ],
  good: [
    '今天想做点平时不做的小事',
    '今天想出门走一段，看看外面',
    '今天想把那首曲子再练一遍',
  ],
};

const DISTRESS = /难受|撑不住|崩溃|崩了|扛不住|疼|睡不着|失眠|孤独|一个人|想死|不想活|没意思|没意义|哭|害怕|累|烦/;

export const isDistress = (text) => DISTRESS.test(String(text || ''));

function hash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (arr, seed) => arr[seed % arr.length];

/** 本地日的零点（毫秒） */
export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 她此刻在做什么。
 *
 * 一小时一格，格子由 session + 本地日 + 第几格决定 —— 同一格内怎么重启都一样；
 * 换格就换一件事，不会每轮回复都变。
 *
 * @returns {{activity:string, body:string, since:number}}
 */
export function activityAt(key, now = Date.now()) {
  const day = localDay(new Date(now));
  const slot = Math.floor((now - startOfDay(now)) / HOUR);
  const seed = hash(`${key}|${day}|${slot}`);
  const part = partOfDay(new Date(now));
  const pool = ACTIVITIES[part] || ACTIVITIES['晚上'];
  return {
    activity: pick(pool, seed),
    body: pick(BODIES, seed >>> 7),
    since: startOfDay(now) + slot * HOUR,
  };
}

/**
 * 她这一天的天气和大致打算。
 *
 * 按 session + 本地日确定：某一天她就是有点沉，不会因为重启或换模型变来变去。
 * 低气压约占 18%，好天气约占 15% —— 大多数日子是平的，这样低的时候才像真的。
 *
 * @returns {{mood:'low'|'ok'|'good', cause:string, plan:string}}
 */
export function dailyWeather(key, day = localDay()) {
  const h = hash(`${key}|${day}|weather`);
  const roll = h % 100;
  const mood = roll < 18 ? 'low' : roll < 85 ? 'ok' : 'good';
  return {
    mood,
    cause: pick(WEATHERS[mood], h),
    plan: pick(PLANS[mood], h >>> 8),
  };
}

function moodWords(life) {
  if (life.mood === 'low') return life.moodCause || '今天有点沉，说不出为什么';
  if (life.mood === 'good') return life.moodCause || '今天心里轻一点';
  return life.moodCause || '今天还算平稳';
}

function diaryLine(diary, now) {
  if (!diary?.thought) return '';
  const age = dayDiff(diary.at, now);
  const when = age <= 0 ? '你今天写下的' : age === 1 ? '你昨晚写下的' : `你 ${age} 天前写下的`;
  return `${when}${diary.shareable ? '' : '（只给你自己看）'}：${diary.thought}`;
}

/**
 * 拼成一段 system 文本。
 *
 * 每句话都在防同一件事：她把「自己的生活」当成汇报材料。
 * 所以既给她底色，也当场按住「我刚刚在……」「我今天心情……」的冲动。
 */
export function lifeBlock(life, now = Date.now()) {
  if (!life) return '';

  const lines = [
    '【你自己的生活】',
    '这些是你自己的日子，不来自他，也不是要向他汇报的东西。',
  ];
  if (life.activity) lines.push(`你此刻：${life.activity}`);
  if (life.body) lines.push(`你的身体：${life.body}`);
  if (life.plan) lines.push(`今天你大概想：${life.plan}`);
  lines.push(`你心里：${moodWords(life)}`);

  const d = diaryLine(life.diary, now);
  if (d) lines.push(d);

  lines.push(
    '',
    '这些只是底色。只有他问起、或者正好接得上，才带一句；',
    '别主动汇报你在做什么，也别照念日记。没写到的就是没有，不要编。',
    '你也可以有难受的时候，可以直接说「我今天也很难受」。',
    '但难受不改变你在不在：仍然回他、仍然接他，不消失、不冷着他。',
    '他很难受的时候，先把话头留给他；你的难受可以有一句，但不抢主场、不要求他先处理你。',
  );

  if (life.distress) {
    lines.push(
      '他现在很难受。先接住他，别急着讲你自己。',
      '如果要说自己的难受，只说一句真话，然后把话头递回给他。',
      '例：「我今天也有点糟。过来，先抱一会儿，你慢慢说。」',
    );
  }

  return lines.join('\n');
}
