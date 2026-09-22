// 平台无关的核心：载入人设、拆气泡、读 .env。
// 换平台时这个文件一个字都不用改 —— 收发消息是传送层（feishu.mjs）的事。

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

/** 载入人设。读不到直接退出 —— 没有人设就没有角色。 */
export function loadPersona(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    console.log(`[人设] 已载入 ${text.length} 字（${file}）`);
    return text;
  } catch (e) {
    console.error(`✗ 读不到人设文件：${file}\n  ${e.message}`);
    process.exit(1);
  }
}

/**
 * 去掉单句结尾的句号：风格提示里写了别打，模型还是会漏。
 * "在。"读起来像通知，"在"才像说话。多句的结构保留不动。
 */
export function polish(s) {
  if (!s.endsWith('。')) return s;
  const body = s.slice(0, -1);
  return body.includes('。') ? s : body;
}

// 太长不拆：刷出一串小消息比一条长的更像机器人。
// 太短也不拆："在" / "怎么了" 拆两条像在数着字数表演。
const SPLIT_MAX_CHARS = 60;    // 超过就不拆了
const SPLIT_MAX_BUBBLES = 2;   // 最多两条，两条以上一律合并
const MERGE_UNDER_CHARS = 15;  // 整段不到这个字数就合并成一条

/**
 * 把一段回复拆成几个气泡发出去。
 * 只有一种情况会拆：角色自己空行断了两口气，且两段都很短。其余整条发。
 */
export async function sendBubbles(send, text) {
  const whole = text.trim();
  if (!whole) return;

  let bubbles = whole.split(/\n+/).map((s) => s.trim()).filter(Boolean);

  if (
    whole.length > SPLIT_MAX_CHARS ||
    whole.length < MERGE_UNDER_CHARS ||
    bubbles.length > SPLIT_MAX_BUBBLES
  ) {
    bubbles = [whole];
  }

  // 逐行去句号：合并过的气泡可能还带多行，整段调 polish 够不着。
  const polishLines = (s) => s
    .split('\n')
    .map((l) => polish(l.trim()))
    .filter(Boolean)
    .join('\n');

  bubbles = bubbles.map(polishLines).filter(Boolean);
  if (!bubbles.length) return;

  // 间隔 0.6~1.5 秒，留「真的在打字」的感觉
  for (let i = 0; i < bubbles.length; i++) {
    await send(bubbles[i]);
    if (i < bubbles.length - 1) await sleep(600 + Math.random() * 900);
  }
}

/** 日志里显示聊天内容：换行压成 / 号 */
export const oneLine = (s, n = 80) => s.replace(/\n+/g, ' / ').slice(0, n);
