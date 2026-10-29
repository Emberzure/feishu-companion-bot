// 千问 TTS 声音复刻测试
//
// 用法：
//   node tools/test-tts.mjs                         # 用 data/voice-sample.wav，合成默认测试句
//   node tools/test-tts.mjs 音频.wav "要说的话"      # 指定音频和文本
//   node tools/test-tts.mjs --reuse "要说的话"       # 复用 data/tts-voice.json 里的音色
//   node tools/test-tts.mjs --voice <音色ID> "要说的话" --out data/x.wav
//   node tools/test-tts.mjs --lang zh 音频.wav "要说的话"   # 中文参考音
//
// 第一次运行会创建音色（声音复刻本身免费），之后每条合成约 ¥0.8/万字符。
// 结果保存到 data/tts-test.wav，音色 ID 保存到 data/tts-voice.json。
//
// 这条线用的是 Qwen-Audio-TTS：
//   创建音色：voice-enrollment + action=create_voice + target_model=qwen-audio-3.1-tts-flash
//   合成语音：audio/tts/SpeechSynthesizer + 同一个 target_model
// 不要和 qwen-voice-enrollment（只配 qwen3-tts-vc-realtime）混用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../bot/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data');

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
const API_KEY = env.DASHSCOPE_API_KEY;
if (!API_KEY) {
  console.error('✗ .env 里没有 DASHSCOPE_API_KEY');
  process.exit(1);
}

const TARGET_MODEL = 'qwen-audio-3.1-tts-flash';
const DEFAULT_AUDIO = path.join(DATA, 'voice-sample.wav');
const DEFAULT_TEXT = '你好，我是角色。今天过得怎么样？';
const MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

const argv = process.argv.slice(2);
const opts = { reuse: false, voice: '', out: '', lang: 'zh' };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--reuse') opts.reuse = true;
  else if (a === '--voice') { opts.voice = argv[++i] || ''; opts.reuse = true; }
  else if (a === '--out') opts.out = argv[++i] || '';
  else if (a === '--lang') opts.lang = argv[++i] || 'zh';
  else pos.push(a);
}

const audioPath = path.resolve(pos[0] || DEFAULT_AUDIO);
const text = (opts.reuse ? pos[0] : pos[1]) || DEFAULT_TEXT;
const outPath = opts.out ? path.resolve(opts.out) : path.join(DATA, 'tts-test.wav');

if (text.length > 600) {
  console.error('✗ 文本超过 600 字符，单次合成上限是 600');
  process.exit(1);
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 800)}`);
  if (data?.code && data.code !== 200 && data.code !== '200' && data.code !== '0') {
    throw new Error(`API error ${data.code}: ${data.message || raw.slice(0, 800)}`);
  }
  return data;
}

function saveVoice(voice) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    path.join(DATA, 'tts-voice.json'),
    JSON.stringify({ voice, targetModel: TARGET_MODEL, at: Date.now() }, null, 2),
  );
}

function loadVoice() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(DATA, 'tts-voice.json'), 'utf8'));
    if (v.voice && v.targetModel === TARGET_MODEL) return v.voice;
  } catch { /* 没有就重新创建 */ }
  return '';
}

async function createVoice() {
  const ext = path.extname(audioPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`不支持的音频格式：${ext}（只支持 wav/mp3/m4a）`);
  if (!fs.existsSync(audioPath)) throw new Error(`找不到音频：${audioPath}`);

  const b64 = fs.readFileSync(audioPath).toString('base64');
  console.log(`→ 创建音色：${audioPath}（base64 ${(b64.length / 1024 / 1024).toFixed(2)} MB）`);

  const data = await postJSON(
    'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',
    {
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: TARGET_MODEL,
        prefix: 'voice',
        url: `data:${mime};base64,${b64}`,
        // 参考音的语言；输出语言由文本本身决定。中文样本用 --lang zh。
        language_hints: [opts.lang],
      },
    },
  );

  const voice = data?.output?.voice_id;
  if (!voice) throw new Error(`创建音色失败：${JSON.stringify(data).slice(0, 800)}`);

  console.log(`✓ voice = ${voice}`);
  saveVoice(voice);
  return voice;
}

async function synthesize(voice) {
  console.log(`→ 合成：${text}`);
  const data = await postJSON(
    'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    {
      model: TARGET_MODEL,
      input: { text, voice, format: 'wav', sample_rate: 24000 },
    },
  );

  const audio = data?.output?.audio;
  if (!audio) throw new Error(`合成失败：${JSON.stringify(data).slice(0, 800)}`);

  const out = outPath;
  if (audio.url) {
    const res = await fetch(audio.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`下载音频失败：HTTP ${res.status}`);
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  } else if (audio.data) {
    fs.writeFileSync(out, Buffer.from(audio.data, 'base64'));
  } else {
    throw new Error('合成返回里没有 audio.url / audio.data');
  }

  console.log(`✓ 已保存：${out}`);
  console.log(`  用量：${data?.usage?.characters ?? '?'} 字符`);
  return out;
}

try {
  const voice = opts.voice || ((opts.reuse && loadVoice()) || await createVoice());
  await synthesize(voice);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
