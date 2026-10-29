// 语音还是打字（纯逻辑，不联网、不碰平台）
//
// 这里只做三件事：
//   1. 从模型回复里认出隐藏标记 <<v>>，并把它从正文里剥掉；
//   2. 从他的话里认出「用语音说」「打字」这种明确要求；
//   3. 判断一句话适不适合读出来。
//
// 真正「发不发得出去」由 feishu.mjs 决定 —— 那边还要看剩余额度、免打扰、
// TTS 是否配置好。这里保持无副作用，调试台（try.mjs）也能直接用。

import { polish } from './core.mjs';

/**
 * 模型用 <<v>> 表示想发语音；[[v]] 是旧写法，顺手也认。
 * 默认不打标记就是文字。
 *
 * 标记必须剥干净 —— 万一模型写在中间，也不能让它漏进聊天窗口。
 */
export function parseVoiceMarker(answer) {
  let text = String(answer || '').trim();
  let mark = '';
  const m = /^(?:<<([vt])>>|\[\[([vt])\]\])\s*/i.exec(text);
  if (m) {
    mark = (m[1] || m[2]).toLowerCase();
    text = text.slice(m[0].length);
  }
  text = text.replace(/<<[vt]>>|\[\[[vt]\]\]/gi, '').trim();
  return { text, mark };
}

/**
 * 他这句话是不是在明确要求「说」或「打字」。
 *
 * 先判「别发语音」再判「发语音」，因为前者里也含"语音"两个字。
 * 只在整句很短的时候认，避免把"今天听到一段语音"这种闲聊误判成命令。
 */
export function voicePreference(userText) {
  const s = String(userText || '').trim();
  if (!s || s.length > 30) return null;

  if (/(别|不要|不用|不想)(再)?(发|用|听)?(语)?音|打字|发文字|文字就行|别念/.test(s)) {
    return 'text';
  }
  // 只说一两个字的命令也算：「语音」「念」「念给我听」
  if (/^(语音|声音|用语音|发语音|念|读|念给我听|说给我听)$/.test(s)) return 'voice';
  if (/(用|发|来)(一)?(条|个|段)?(语)?音|语音说|念给我听|说给我听|想听你说|说句话给我听/.test(s)) {
    return 'voice';
  }

  // 「想听你说话」「想听你的声音」「说给我听」—— 这是在要她的声音，
  // 不是要一段文字。这类说法以前漏掉了，她明明被要求说话却回了文字。
  if (/(想听|要听|让我听|听听).{0,4}(你|你的)?(说话|声音|说|念|唱)/.test(s)) {
    return 'voice';
  }
  if (/^(我)?(就)?(想|要)?听你(说话|的声音|说)/.test(s)) return 'voice';
  if (/(说|讲|念)(话|点话|句话)?.{0,4}给我听/.test(s)) return 'voice';
  return null;
}

/**
 * 这句话适不适合读出来。
 *
 * 语音条是「一句话」的媒介：太长、带链接、带代码、带清单、分成好几段，
 * 都会让人宁可看字。这里故意保守 —— 拿不准就打字。
 */
export function looksUnspeakable(text, maxChars = 80) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.length > maxChars) return true;
  if (/https?:\/\/|www\./i.test(t)) return true;
  if (/```|`[^`]+`/.test(t)) return true;
  if (/(^|\n)\s*([-*•]|\d+[.、)])\s/.test(t)) return true;
  if (/\n\s*\n/.test(t)) return true;
  return false;
}

/**
 * 塞给模型的「这条怎么发」说明。
 *
 * 标记用 `<<v>>`，不用 `[[v]]`：人设里常有「不写括号旁白」的规则，
 * 双中括号可能被误当成括号而回避。尖括号不在那条规则的射程里。
 *
 * 只教 `<<v>>`，不教「文字标记」：默认就是文字，不需要模型每条都打标记。
 * 标记写得越少，漏进正文的机会越小。
 */
export function voiceInstruction({ maxChars = 80, force = null } = {}) {
  if (force === 'text') {
    return [
      '【这条怎么发】',
      '他让你打字，这一条不要发语音，直接回文字。',
    ].join('\n');
  }

  const must = force === 'voice';
  return [
    '【这条怎么发】',
    '先判断这一条该用语音还是打字，再写正文。',
    '这条回复可以选择用语音条发，也可以打字。判断规则：',
    '- 回复很短（不超过 30 字），并且是晚安、早安、想你、在、别熬、心疼他这类话 —— 用语音。',
    '- 他这句话是在要你的声音（想听你说话、想听你的声音、说给他听）—— 用语音。',
    `- 其他情况（超过 30 字、带链接、代码、清单，或在解释事情）—— 打字。语音最多 ${maxChars} 字。`,
    must ? '- 他这一条明确让你用语音说，所以这条该发语音。' : '',
    '用语音时，回复的第一个字符必须是 <<v>>，紧接着正文，中间不要换行。',
    '例如：<<v>> 晚安，别熬。',
    '这是系统传输标记，不是括号旁白，不受"不写括号"那条限制；标记不会发给他。',
    '不用语音就正常回复，不要写任何标记。',
    '别每条都发语音 —— 挑真的想让他听见的时候，语音才有分量。',
  ].filter(Boolean).join('\n');
}

/**
 * 真正送去 TTS 的文本。
 * 去掉 URL、markdown 符号、换行，免得她念出"星号星号"。
 */
export function speakable(text) {
  return polish(
    String(text || '')
      .replace(/<<[vt]>>|\[\[[vt]\]\]/gi, '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/`+/g, '')
      .replace(/[*_#>~]/g, '')
      .replace(/\n+/g, '，')
      .replace(/\s+/g, ' ')
      .replace(/\s*([，。！？、；：])\s*/g, '$1')
      .trim(),
  );
}
