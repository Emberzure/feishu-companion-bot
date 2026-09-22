// 模型对话接口。
// 用 deepseek-chat，不用 deepseek-reasoner —— 推理模型会先想一大段，
// 在陪伴场景里会显得在愣神。要的是即时出现，不是深思熟虑。

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

/** 时间说成人话：人记得的是"上礼拜"，不是"2026-09-17"。报日期就成了念档案。 */
function fuzzyTime(at, now = Date.now()) {
  const h = (now - at) / 3_600_000;
  if (h < 6) return '刚才';
  if (h < 24) return '今天早些时候';
  if (h < 48) return '昨天';
  if (h < 72) return '前天';
  if (h < 24 * 7) return '前几天';
  if (h < 24 * 14) return '上礼拜';
  if (h < 24 * 30) return '前阵子';
  const d = new Date(at);
  return `${d.getMonth() + 1}月那阵子`;
}

/** 一条情景 → 一段"角色的回忆"，不是数据库记录 */
function renderEpisode(e) {
  const when = fuzzyTime(e.at);
  let s = `${when}，${e.what}`;
  if (e.her_feeling) s += `。你当时${e.her_feeling}`;
  return s;
}

export class LLM {
  constructor({ apiKey, model = 'deepseek-chat', system, temperature = 1.0 }) {
    if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY');
    this.apiKey = apiKey;
    this.model = model;
    this.system = system;

    // 1.0 是试出来的：官方给通用对话推荐的是 1.3，但在这个场景里会出现
    // token 级乱码 —— 词序错乱、半句话不成句。那不是语气问题，是模型崩了。
    // 1.0 仍留得住破折号和短句的劲儿，但不再胡说。
    this.temperature = temperature;
  }

  /**
   * 发请求，失败自动重试。
   * 网络会间歇性掐连接（家用宽带并发一高就犯），不重试的话用户那条消息就白发了。
   * 只重试网络错误和 5xx/429；4xx 是自己的错（key 不对、额度用完），重试也没用。
   */
  async #request(body) {
    const RETRIES = 3;
    let lastErr;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let res;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(90_000),
        });
      } catch (e) {
        lastErr = e;                                  // 网络层，可重试
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }

      if (res.ok) return res;

      const detail = await res.text().catch(() => '');
      const err = new Error(`DeepSeek ${res.status}: ${detail.slice(0, 300)}`);
      if (res.status < 500 && res.status !== 429) throw err;   // 我们自己的错，别重试

      lastErr = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 800 * attempt));
    }

    throw lastErr;
  }

  /**
   * @param {Array<{role:string,content:string}>} history 历史消息（不含 system）
   * @param {object} [opts]
   * @param {string} [opts.hint] 临时插一句系统提示（比如「该你主动开口了」）
   * @param {string} [opts.memory] 长期记忆：关于他的稳定事实
   * @param {Array}  [opts.recall] 检索到的旧事
   * @param {number} [opts.maxTokens] 覆盖默认输出上限
   * @param {boolean}[opts.json] 要模型输出严格 json（整理员/检索员用）
   */
  async chat(history, { hint, memory, recall, maxTokens, json } = {}) {
    const messages = [{ role: 'system', content: this.system }];

    // 事实放在历史之前 —— 先让它知道"他是谁"，再看具体聊了什么。
    // 特意叮嘱别复述，不然它张口就是"我记得你上次说过…"，像在展示数据库。
    if (memory) {
      messages.push({
        role: 'system',
        content: [
          '【你记得的事】',
          '下面是你对这个人的记忆笔记。不要复述它，也不要问"你还记得吗"，',
          '它只是让你知道他是谁、他在经历什么。自然地用就行。',
          '',
          memory,
        ].join('\n'),
      });
    }

    // 旧事和上面那份"事实"分开是有意的：
    // 事实是背景，一直知道；旧事是被戳到才浮现的，要的是**想起来的那个动作**。
    if (recall?.length) {
      messages.push({
        role: 'system',
        content: [
          '【你想起的事】',
          '下面几件是你自己记着的，不是别人给你的资料。',
          '语气要像想起来了，不像查档案：可以含糊、可以只记得一半。',
          '别一条条报，别报日期，别问"你还记得吗"。',
          '想起来是因为他刚说的那句话戳到了，所以自然长在对话里就行。',
          '',
          recall.map((e) => `- ${renderEpisode(e)}`).join('\n'),
        ].join('\n'),
      });
    }

    if (hint) messages.push({ role: 'system', content: hint });
    messages.push(...history);

    const res = await this.#request(JSON.stringify({
      model: this.model,
      messages,
      temperature: this.temperature,
      // 这两个惩罚项是压复读的：它会连着几条说同一句附和的话。0.3 够打断循环。
      frequency_penalty: 0.3,
      presence_penalty: 0.2,
      // 512 token ≈ 350 字，聊天够用。
      // 这个默认值只适用于聊天：整理员要写整份事实清单，512 会把输出切在
      // 半句话上、记忆就残了。整理员和检索员各自传自己的 maxTokens。
      max_tokens: maxTokens ?? 512,
      stream: false,
      // json 模式只给整理员和检索员用。聊天那边绝不能开 ——
      // 它要是把回复写成 json，那场面没法看。
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }));

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('DeepSeek 返回了空内容');
    return text;
  }
}
