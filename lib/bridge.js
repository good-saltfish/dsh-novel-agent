'use strict';

/**
 * DSH 模型桥（Host 半）。
 *
 * 为什么需要这一层：ndecon 引擎是 Python 进程，它所有的 AI 调用都走
 * 「HTTP 打一个 OpenAI 兼容端点」（`src/ndecon/providers/openai_compat.py`）。
 * 而用户要的是「用 DSH 里配好的模型」——那模型只存在于宿主进程里，
 * 由 `llm` 服务的 `llm.stream()` 提供，Python 进程够不着。
 *
 * 所以这里在插件进程里起一个**只监听 127.0.0.1 的 OpenAI 兼容端点**，
 * 把 `/v1/chat/completions` 翻译成 `llm.stream()`。好处是 ndecon 一行都不用改：
 * 它用现成的 `custom` 供应商（base_url + api_key + model）就能接上，
 * 少一份实现就少一处会跟 Python 走偏的地方。
 *
 * 三条安全线：
 *   1. 只绑 127.0.0.1，不暴露到局域网；
 *   2. 每次插件启动生成随机 token，请求必须带 `Authorization: Bearer <token>`；
 *   3. 端口由内核挑（listen(0)），不写死，避免与别的进程抢。
 */

import crypto from 'node:crypto';
import http from 'node:http';

/** 单次请求体上限：上下文包最大也就几十 KB。 */
const MAX_BODY = 2 * 1024 * 1024;

/**
 * 推理档位排序。DeepSeek 适配器默认 `high`，写 2700 字正文若也用 high，
 * 推理会吃掉整个输出预算（实测拿到空回复）。取公示档位里最便宜的一档。
 *
 * `ModelInfo.reasoning.efforts` 的每一项是 `{ id, name }` 对象而不是裸字符串
 * （见 dsh-llm 的 normalizeModelInfo）；宿主校验时拿 `effort.id` 比对，
 * 传整个对象会报 `does not support reasoning effort "[object Object]"`。
 */
const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'none'];

export async function lowestReasoningEffort(llm, route) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined;
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
      ? info.reasoning.efforts
      : [];
    const ids = efforts
      .map((effort) => (typeof effort === 'string' ? effort : effort && typeof effort.id === 'string' ? effort.id : undefined))
      .filter((id) => typeof id === 'string');
    if (ids.length === 0) return undefined;
    return ids.slice().sort((a, b) => EFFORT_RANK.indexOf(a) - EFFORT_RANK.indexOf(b))[0];
  } catch {
    return undefined; // 读不到就不带这个字段，让适配器自己定
  }
}

/**
 * 从 finish 块里抠失败原因。
 *
 * 宿主把「模型为什么没吐字」放在 finish 块的 `reason.failure.message` 里
 * （401 无效 key、额度用尽、上下文超长）。不抠出来，界面上只会显示
 * 「模型没返回内容」，用户根本不知道自己该去改哪。
 */
export function extractFailure(meta) {
  for (const raw of meta) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const failure = parsed && parsed.reason && parsed.reason.failure;
    if (failure && typeof failure.message === 'string' && failure.message.trim()) {
      const code = typeof failure.code === 'string' && failure.code.trim() ? `${failure.code}: ` : '';
      return code + failure.message.trim();
    }
    const kind = parsed && parsed.reason && parsed.reason.kind;
    if (typeof kind === 'string' && kind && kind !== 'stop') return kind;
  }
  return '';
}

/**
 * 引擎发的是 `response_format: {type:'json_object'}`，而宿主的 `llm.stream`
 * 没有这个参数。它不生效的话，模型会按自己的习惯加 markdown 围栏或解释文字，
 * 引擎虽然能剥围栏（`_parse_json`），但多一层就多一次失败机会。
 *
 * 所以在这里把它翻译成一句明确的系统指令——这是桥该做的事：把 OpenAI 的
 * 参数语义带到宿主那边去，而不是假装收到了然后丢掉。
 */
const JSON_MODE_INSTRUCTION =
  '只输出一个 JSON 对象。不要 markdown 围栏，不要在 JSON 前后写任何解释、寒暄或标题。';

export function jsonModeInstruction(payload) {
  const format = payload && payload.response_format;
  return format && typeof format === 'object' && format.type === 'json_object' ? JSON_MODE_INSTRUCTION : '';
}

/**
 * 把 OpenAI 的 messages 转成宿主 `llm.stream` 认的形状。
 *
 * 两个必须点：
 *   1) `content` 必须是 content block 数组，裸字符串可能被当成空消息；
 *   2) user 消息要带 `source`，宿主据此区分「谁发的」。
 * system 单独抽出来走 `system` 参数（宿主的 system 是顶层字段）。
 */
export function toHostMessages(messages) {
  const out = [];
  let system = '';
  for (const raw of messages || []) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'system' ? 'system' : 'user';
    const text = typeof raw.content === 'string'
      ? raw.content
      : Array.isArray(raw.content)
        ? raw.content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('')
        : String(raw.content ?? '');
    if (role === 'system') {
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    out.push({
      role,
      content: [{ type: 'text', text }],
      ...(role === 'user' ? { source: { kind: 'plugin:dsh-novel-studio' } } : {}),
    });
  }
  return { messages: out, system };
}

function openAiError(message, code) {
  return { error: { message, type: 'invalid_request_error', code: code || 'bridge_error' } };
}

/**
 * 探测用的提示词与预算。
 *
 * 只问两个字：探测要回答的是「这个 provider+model 现在通不通、几秒答得出来」，
 * 不是「它能写多好」。预算给 64 而不是 1——推理型模型会把 1 个 token 全花在
 * reasoning 上，正文一个字符都留不下，那时看到的「空」是预算造成的，不是链路断。
 * 64 足够让「回两个字」这件事在推理之后还有余量。
 */
const PROBE_PROMPT = '只回复两个字：可用。不要解释，不要加标点或引号。';
const PROBE_MAX_TOKENS = 64;
/** 超过这个耗时就在结果里提示：能通，但写一章几千字会久到让人以为卡死。 */
const PROBE_SLOW_MS = 15000;

/**
 * 测一个指定模型（不经过引擎，也不改任何设置）。
 *
 * 为什么必须有这条：引擎的 `/api/llm/test` 测的是**引擎已经配好的那个模型**，
 * 而用户真正想知道的是「我下拉框里挑的这个行不行」。要是只能先保存再去引擎里
 * 测，那测一次就得改一次配置，试错成本高到没人愿意试。
 *
 * 判据刻意分三层，不要把三种情况混成一个「失败」：
 *   1. 有正文 → 通；
 *   2. 没有正文但 finish 是 length → **链路通**，只是预算被推理吃掉。
 *      这不是模型坏了，把它报成失败会让人去换一个本来没问题的模型；
 *   3. 其它（401/额度/超时/上下文超长）→ 失败，把宿主给的原始原因带出来。
 */
export async function probeModel(llm, route, { log } = {}) {
  const note = (tag, data) => { if (typeof log === 'function') log(tag, data); };
  const startedAt = Date.now();
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, ms: 0, code: 'no-llm', failure: 'DSH 宿主没有提供模型服务（llm）' };
  }
  if (!route || !route.provider || !route.model) {
    return { ok: false, ms: 0, code: 'no-model', failure: '还没有选模型' };
  }
  const effort = await lowestReasoningEffort(llm, route);
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: PROBE_PROMPT }],
    source: { kind: 'plugin:dsh-novel-studio' },
  }];
  let text = '';
  const meta = [];
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      messages,
      temperature: 0,
      maxTokens: PROBE_MAX_TOKENS,
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk && typeof chunk.type === 'string') meta.push(JSON.stringify(chunk));
    }
  } catch (error) {
    const ms = Date.now() - startedAt;
    note('probe-error', { provider: route.provider, model: route.model, ms, message: String(error && error.message) });
    return { ok: false, ms, failure: String((error && error.message) || error) };
  }
  const ms = Date.now() - startedAt;
  const failure = extractFailure(meta);
  const sample = text.trim().slice(0, 60);
  const slow = ms > PROBE_SLOW_MS ? `这次花了 ${(ms / 1000).toFixed(1)} 秒，偏慢；写一章几千字会更久。` : '';
  if (sample) {
    return { ok: true, ms, sample, effort, note: slow };
  }
  if (failure === 'length') {
    return {
      ok: true,
      ms,
      sample: '',
      effort,
      note: `链路是通的，但这次预算全花在推理上、正文为空（finish_reason=length）。${slow}`.trim(),
    };
  }
  note('probe-no-text', { provider: route.provider, model: route.model, ms, failure });
  return { ok: false, ms, sample: '', failure: failure || '模型没有返回任何内容' };
}

/**
 * 建桥。
 *
 * `getLlm()` 每次请求都重新取 `llm` 服务（宿主可能后加载它）；
 * `getRoute()` 返回当前选中的 `{provider, model}`，没选就抛。
 */
export function createLlmBridge({ getLlm, getRoute, log }) {
  const token = crypto.randomBytes(24).toString('hex');
  let server = null;
  let origin = null;

  function note(tag, data) {
    if (typeof log === 'function') log(tag, data);
  }

  async function complete(payload) {
    const llm = getLlm();
    if (!llm || typeof llm.stream !== 'function') {
      throw Object.assign(new Error('DSH 宿主没有提供模型服务（llm）'), { status: 503, code: 'no-llm' });
    }
    const route = await getRoute();
    if (!route || !route.provider || !route.model) {
      throw Object.assign(new Error('还没有选模型：先在「模型」页选一个，或在 DSH 设置里配默认模型'), { status: 503, code: 'no-model' });
    }
    const { messages, system } = toHostMessages(payload.messages);
    if (messages.length === 0) {
      throw Object.assign(new Error('messages 为空'), { status: 400, code: 'bad-request' });
    }
    const extra = jsonModeInstruction(payload);
    const mergedSystem = [system, extra].filter(Boolean).join('\n\n');
    const effort = await lowestReasoningEffort(llm, route);
    // max_tokens 原样透传（0 或缺失 = 不指定，交给宿主/适配器的默认上限）。
    //
    // 这里曾经有一道 `MIN_TRUSTED_MAX_TOKENS = 512` 的过滤：引擎的连通性测试
    // 发 max_tokens:1，推理型模型会把这点预算全花在推理上、正文为空，于是
    // 测试报「连接成功但返回空内容」。那道过滤是**用一个补丁盖住另一个判据
    // 错误**——真正错的是引擎拿 content 是否为空当连通性判据（已改为看
    // finish_reason / completion_tokens，见 ndecon 的 llm/session.py）。
    // 判据修好后过滤就必须撤掉，否则它会吃掉所有真实的小预算请求，
    // 让「引擎说了给多少」和「宿主实际给多少」永远对不上。
    const requestedTokens = Number.isFinite(payload.max_tokens) ? Math.trunc(payload.max_tokens) : null;
    const maxTokens = requestedTokens !== null && requestedTokens > 0 ? requestedTokens : null;
    let text = '';
    const meta = [];
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(mergedSystem ? { system: mergedSystem } : {}),
      messages,
      ...(Number.isFinite(payload.temperature) ? { temperature: payload.temperature } : {}),
      ...(maxTokens === null ? {} : { maxTokens }),
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk && typeof chunk.type === 'string' && chunk.type !== 'text-delta') meta.push(JSON.stringify(chunk));
    }
    if (!text.trim()) {
      const failure = extractFailure(meta);
      note('bridge-no-text', { provider: route.provider, model: route.model, effort, failure });
      throw Object.assign(
        new Error(`模型没返回内容${failure ? `（${failure}）` : ''}`),
        { status: 502, code: 'model-failed' },
      );
    }
    return { text, route, effort };
  }

  async function handle(req, res) {
    const send = (status, body) => {
      if (res.headersSent) return;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${token}`) {
      send(401, openAiError('token 不匹配', 'unauthorized'));
      return;
    }
    const path = (req.url || '').split('?')[0];
    if (path === '/v1/models' || path === '/models') {
      let route = null;
      try { route = await getRoute(); } catch { route = null; }
      send(200, { object: 'list', data: route && route.model ? [{ id: route.model, object: 'model' }] : [] });
      return;
    }
    if ((path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        send(400, openAiError('请求体不是合法 JSON'));
        return;
      }
      try {
        const { text } = await complete(payload || {});
        send(200, {
          id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: (payload && payload.model) || '',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: {},
        });
      } catch (error) {
        const status = Number.isInteger(error && error.status) ? error.status : 502;
        note('bridge-error', { status, message: String(error && error.message) });
        send(status, openAiError(String((error && error.message) || error), error && error.code));
      }
      return;
    }
    send(404, openAiError('未知端点：' + path, 'not_found'));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        parts.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8') || '{}'));
      req.on('error', reject);
    });
  }

  return {
    /** 起服务；幂等，返回 origin（如 http://127.0.0.1:41731）。 */
    async start() {
      if (origin) return origin;
      await new Promise((resolve, reject) => {
        const created = http.createServer((req, res) => {
          handle(req, res).catch((error) => {
            try { res.destroy(error); } catch { /* 已断开 */ }
          });
        });
        created.once('error', reject);
        created.listen(0, '127.0.0.1', () => {
          server = created;
          origin = `http://127.0.0.1:${created.address().port}`;
          resolve();
        });
      });
      return origin;
    },
    stop() {
      const current = server;
      server = null;
      origin = null;
      if (current) {
        try { current.close(); } catch { /* 已关闭 */ }
      }
    },
    get origin() { return origin; },
    /** token 只给同一个进程里的 panel 配置用，绝不进日志/设置文件。 */
    get token() { return token; },
  };
}
