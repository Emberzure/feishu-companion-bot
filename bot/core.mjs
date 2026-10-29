// 平台无关的核心：载入人设、说话风格、拆气泡。
//
// 这个文件里放的全是「不管她在哪聊天都一样」的东西：
//   · 人设怎么载入
//   · 说话风格（短句、不分括号、不句句打句号……）
//   · 回复怎么拆成几个气泡
//   · 调模型、记记忆
//
// 具体「怎么把消息收进来、怎么发出去」由各平台的传送层负责。
// 换平台时，这个文件一个字都不用改。

import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 .env：很土但够用，只认 KEY=VALUE 行 */
export function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 没有就没有 */ }
  return out;
}

/** 载入人设原文。读不到就直接退出 —— 没有人设就没有角色。 */
export function loadPersona(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    console.log(`📖 人设已载入：${text.length} 字（${file}）`);
    return text;
  } catch (e) {
    console.error(`✗ 读不到人设文件：${file}\n  ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 说话风格
//
// 这里以前有一层 CHAT_STYLE，盖在人设上面改说话方式。后来把它并进人设文件的
// 第三节了，两个理由：
//   1. 两层会打架 —— 人设说"用括号旁白"，CHAT_STYLE 说"别用"，
//      模型每次都要自己判断哪条算数，这拖累输出。
//   2. 一个源头好维护，你也少一处要改的地方。
//
// 所以：**想调她说话的调调，去改人设文件第三节**（persona.md）。
// 别再往这里加东西。

// ---------------------------------------------------------------- 发消息

/**
 * 单句消息结尾的句号去掉。
 * 风格提示里已经写了别打句号，但模型还是会漏 —— "在。"读起来像通知，
 * "在"才像说话。只动单句，多句的结构保留。
 */
export function polish(s) {
  if (!s.endsWith('。')) return s;
  const body = s.slice(0, -1);
  return body.includes('。') ? s : body;
}

// 拆条的上下限。
//
// 上面那条：她的话太长就整条发，不再切。
//   以前这里会把长回复按句号切成 60 字一段，结果她说得越多、刷出来的小消息越多，
//   连着十二条往外蹦 —— 那比一条长的更像机器人。说得多就一条说完。
//
// 下面那条：太短的也不拆。
//   "在" / "怎么了" 拆成两条发出去显得刻意，像在数着字数表演。
//   一条"在，怎么了"才像人随手打的。
const SPLIT_MAX_CHARS = 60;    // 超过就不拆了
const SPLIT_MAX_BUBBLES = 2;   // 最多两条，两条以上一律合并
const MERGE_UNDER_CHARS = 15;  // 整段不到这个字数就合并成一条

/**
 * 把一段回复拆成几个气泡发出去。
 * send 是平台给的发送函数：send('要说的话')。
 *
 * 只有一种情况会拆：她自己空行断了两口气，而且两段都很短。
 * 其余一律一条发完。拆条之间停半秒，是留「真的在打字」的感觉。
 */
export async function sendBubbles(send, text) {
  const whole = text.trim();
  if (!whole) return;

  let bubbles = whole.split(/\n+/).map((s) => s.trim()).filter(Boolean);

  // 太长 / 段数太多 / 整段太短 —— 都当成一整条发（保留段间换行，读起来有结构）
  if (
    whole.length > SPLIT_MAX_CHARS ||
    whole.length < MERGE_UNDER_CHARS ||
    bubbles.length > SPLIT_MAX_BUBBLES
  ) {
    bubbles = [whole];
  }

  // 逐行去句号。
  // 合并过的气泡里可能还带着多行（"在。\n\n手给我。"），只对整段调 polish 够不着它 ——
  // 整段有多句时 polish 会故意保留句号。所以拆到每一行分别处理。
  const polishLines = (s) => s
    .split('\n')
    .map((l) => polish(l.trim()))
    .filter(Boolean)
    .join('\n');

  bubbles = bubbles.map(polishLines).filter(Boolean);
  if (!bubbles.length) return;

  for (let i = 0; i < bubbles.length; i++) {
    await send(bubbles[i]);
    if (i < bubbles.length - 1) await sleep(600 + Math.random() * 900);
  }
}

/** 聊天记录里那一行日志怎么显示：换行压成 / 号 */
export const oneLine = (s, n = 80) => s.replace(/\n+/g, ' / ').slice(0, n);
