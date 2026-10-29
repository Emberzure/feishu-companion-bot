// 语音合成（千问 TTS 复刻音色）
//
// 链路：文字 → 千问合成 wav → ffmpeg 转 Opus（16k 单声道）→ 返回给飞书层上传。
//
// 音色只需要复刻一次（tools/test-tts.mjs），之后每条都只发「文字 + 音色 ID」，
// 不再传参考音。音色 ID 存在 data/tts-voice.json。
//
// 这一层只负责「把字变成能发的音频」。要不要发语音、发给谁，由 feishu.mjs 决定；
// 合成失败也由那边兜底改发文字 —— 绝不能因为语音链路坏了就不回消息。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const DEFAULT_MODEL = 'qwen-audio-3.1-tts-flash';
const MAX_CHARS = 600;         // 接口单次上限
const SYNTH_TIMEOUT_MS = 45_000;   // 超时就放弃语音、改发文字，别让她一直不回

/**
 * @param {object} opts
 * @param {string} opts.apiKey        DASHSCOPE_API_KEY
 * @param {string} [opts.model]       TTS 模型（必须和创建音色时的 target_model 一致）
 * @param {string} [opts.voiceId]     直接指定音色；不给就读 data/tts-voice.json
 * @param {string} [opts.voiceFile]   音色文件位置
 * @param {string} [opts.tmpDir]      临时 wav/opus 放哪
 * @param {number} [opts.rate]        语速，0.5–2.0，默认 1.2（1.0 是她复刻出来的原速）
 */
export function createTTS({
  apiKey,
  model = DEFAULT_MODEL,
  voiceId = '',
  voiceFile = path.join(ROOT, 'data', 'tts-voice.json'),
  tmpDir = path.join(ROOT, 'data', 'tmp'),
  rate = 1.2,
} = {}) {
  let voice = String(voiceId || '').trim();
  let reason = '';

  if (!apiKey) {
    reason = '没有 DASHSCOPE_API_KEY';
  } else if (!voice) {
    try {
      const saved = JSON.parse(fs.readFileSync(voiceFile, 'utf8'));
      if (saved.voice && saved.targetModel === model) {
        voice = saved.voice;
      } else if (saved.voice) {
        // 音色和模型是绑定的，混用会报 Invalid voice specified。
        reason = `音色绑定的模型是 ${saved.targetModel || '（未知）'}，和当前 ${model} 不一致`;
      } else {
        reason = '音色文件里没有 voice';
      }
    } catch {
      reason = `还没创建音色（${voiceFile}）`;
    }
  }

  const available = !reason;
  const speed = Math.min(2, Math.max(0.5, Number(rate) || 1));

  async function postJSON(body) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    });
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 400)}`);
    if (data?.code && data.code !== 200 && data.code !== '200' && data.code !== '0') {
      throw new Error(`TTS ${data.code}: ${data.message || raw.slice(0, 400)}`);
    }
    return data;
  }

  async function download(audio) {
    if (audio?.url) {
      const res = await fetch(audio.url, { signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`下载合成音频失败：HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    if (audio?.data) return Buffer.from(audio.data, 'base64');
    throw new Error('TTS 返回里没有 audio.url / audio.data');
  }

  /**
   * 合成一句话，直接转成飞书能收的 Opus。
   * @returns {Promise<{buffer: Buffer, durationMs: number, cleanup: () => void}>}
   */
  async function synthesize(text) {
    if (!available) throw new Error(reason);

    const spoken = String(text || '').trim();
    if (!spoken) throw new Error('空文本');
    if (spoken.length > MAX_CHARS) throw new Error(`文本 ${spoken.length} 字，超过 ${MAX_CHARS}`);

    const data = await postJSON({
      model,
      input: { text: spoken, voice, format: 'wav', sample_rate: 24000 },
      // 语速放在 parameters 里。实测 parameters.rate 有效；
      // input.rate / input.speed / speech_rate 都不可靠（见 2026-10-20 实测）。
      parameters: { rate: speed },
    });
    const wavBuffer = await download(data?.output?.audio);

    fs.mkdirSync(tmpDir, { recursive: true });
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wav = path.join(tmpDir, `tts-${tag}.wav`);
    const opus = path.join(tmpDir, `tts-${tag}.opus`);
    const cleanup = () => {
      for (const f of [wav, opus]) {
        try { fs.rmSync(f, { force: true }); } catch { /* 清不掉就算了 */ }
      }
    };

    try {
      fs.writeFileSync(wav, wavBuffer);

      // 飞书只收 Opus。16k 单声道是官方推荐的语音消息规格。
      await run('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', wav,
        '-ac', '1', '-ar', '16000',
        '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on',
        '-f', 'ogg', opus,
      ], { timeout: 20_000 });

      const { stdout } = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1', opus,
      ], { timeout: 10_000 });

      const seconds = Number.parseFloat(String(stdout).trim());
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('读不出音频时长');

      return {
        buffer: fs.readFileSync(opus),
        durationMs: Math.max(1, Math.round(seconds * 1000)),
        cleanup,
      };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  return { available, reason, voice, model, rate: speed, synthesize };
}
