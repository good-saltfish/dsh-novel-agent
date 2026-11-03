/**
 * 模型桥测试：不连真模型，用假的 `llm` 服务把桥的每条分支都跑一遍。
 *
 * 重点验的是「会不会静默假装成功」——桥一旦吞掉错误，用户看到的是
 * 「生成了但内容不对」，那比直接报错难查得多。
 */

import { createLlmBridge, extractFailure, lowestReasoningEffort, toHostMessages } from '../lib/bridge.js';

let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };
const bad = (name, detail) => { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); };

function fakeLlm({ deltas = ['你好', '，世界'], efforts, failKind, throwOnStream } = {}) {
  return {
    async resolveModelInfo() {
      return efforts === undefined
        ? { reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }] } }
        : { reasoning: { efforts } };
    },
    async *stream(params) {
      if (throwOnStream) throw new Object({ message: '炸了' });
      yield { type: 'meta', provider: params.provider };
      for (const text of deltas) yield { type: 'text-delta', text };
      yield {
        type: 'finish',
        reason: failKind
          ? { kind: failKind, failure: { code: 'rate_limit', message: '额度用尽' } }
          : { kind: 'stop' },
      };
    },
  };
}

async function request(origin, token, path, body) {
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

const bridge = createLlmBridge({
  getLlm: () => fakeLlm(),
  getRoute: async () => ({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
  log: () => {},
});
const origin = await bridge.start();

// 1. token 是必须的：没有它就等于把本机任意进程都能用的模型端点敞开。
{
  const { status } = await request(origin, null, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
  status === 401 ? ok('不带 token 被拒 401') : bad('不带 token 被拒 401', `status=${status}`);
}
{
  const { status } = await request(origin, 'wrong-token', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
  status === 401 ? ok('错误 token 被拒 401') : bad('错误 token 被拒 401', `status=${status}`);
}

// 2. 正常一次补全
{
  const { status, body } = await request(origin, bridge.token, '/v1/chat/completions', {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'deepseek-v4.1-flash',
  });
  const content = body?.choices?.[0]?.message?.content;
  status === 200 && content === '你好，世界'
    ? ok('正常补全返回拼接后的文本')
    : bad('正常补全返回拼接后的文本', `status=${status} content=${content}`);
  body?.object === 'chat.completion' ? ok('响应是标准 OpenAI 形状') : bad('响应是标准 OpenAI 形状', body?.object);
}

// 3. /v1/models 要报当前模型，否则引擎测试连通性时看到空列表会以为没配好
{
  const { status, body } = await request(origin, bridge.token, '/v1/models');
  status === 200 && body?.data?.[0]?.id === 'deepseek-v4.1-flash'
    ? ok('/v1/models 报当前模型')
    : bad('/v1/models 报当前模型', JSON.stringify(body));
}

// 4. 模型空回复要报失败，不能返回空字符串当成功
{
  const empty = createLlmBridge({
    getLlm: () => fakeLlm({ deltas: [], failKind: 'error' }),
    getRoute: async () => ({ provider: 'deepseek', model: 'x' }),
    log: () => {},
  });
  const o = await empty.start();
  const { status, body } = await request(o, empty.token, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
  status === 502 && String(body?.error?.message).includes('额度用尽')
    ? ok('空回复报 502 并带上宿主的失败原因')
    : bad('空回复报 502 并带上宿主的失败原因', `status=${status} ${JSON.stringify(body)}`);
  empty.stop();
}

// 5. 没有 llm 服务 / 没有选模型：各自 503 且文案能指导用户
{
  const noLlm = createLlmBridge({ getLlm: () => undefined, getRoute: async () => ({ provider: 'a', model: 'b' }), log: () => {} });
  const o = await noLlm.start();
  const { status, body } = await request(o, noLlm.token, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
  status === 503 && body?.error?.code === 'no-llm'
    ? ok('宿主没有 llm 服务时 503 no-llm')
    : bad('宿主没有 llm 服务时 503 no-llm', `status=${status} ${JSON.stringify(body)}`);
  noLlm.stop();
}
{
  const noModel = createLlmBridge({ getLlm: () => fakeLlm(), getRoute: async () => undefined, log: () => {} });
  const o = await noModel.start();
  const { status, body } = await request(o, noModel.token, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
  status === 503 && body?.error?.code === 'no-model'
    ? ok('没选模型时 503 no-model')
    : bad('没选模型时 503 no-model', `status=${status} ${JSON.stringify(body)}`);
  noModel.stop();
}

// 6. 非法 JSON 与空 messages
{
  const response = await fetch(origin + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
    body: '{oops',
  });
  response.status === 400 ? ok('非法 JSON 被拒 400') : bad('非法 JSON 被拒 400', `status=${response.status}`);
}
{
  const { status } = await request(origin, bridge.token, '/v1/chat/completions', { messages: [] });
  status === 400 ? ok('空 messages 被拒 400') : bad('空 messages 被拒 400', `status=${status}`);
}

// 7. 未知端点
{
  const { status } = await request(origin, bridge.token, '/v1/nope');
  status === 404 ? ok('未知端点 404') : bad('未知端点 404', `status=${status}`);
}

// 8. 纯函数
{
  const { messages, system } = toHostMessages([
    { role: 'system', content: '你是编剧' },
    { role: 'user', content: '写第一章' },
    { role: 'assistant', content: '好的' },
  ]);
  messages.length === 2 && system === '你是编剧'
    ? ok('system 抽成顶层字段，其余转 content block')
    : bad('system 抽成顶层字段，其余转 content block', JSON.stringify({ messages, system }));
  Array.isArray(messages[0].content) && messages[0].content[0].type === 'text'
    ? ok('content 是 block 数组（裸字符串可能被当空消息）')
    : bad('content 是 block 数组', JSON.stringify(messages[0]));
  messages[0].source?.kind === 'plugin:dsh-novel-studio'
    ? ok('user 消息带 source')
    : bad('user 消息带 source', JSON.stringify(messages[0].source));
}
{
  const effort = await lowestReasoningEffort(fakeLlm(), { provider: 'p', model: 'm' });
  effort === 'low' ? ok('推理档取最便宜的一档（id 而不是对象）') : bad('推理档取最便宜的一档', String(effort));
}
{
  const effort = await lowestReasoningEffort({}, { provider: 'p', model: 'm' });
  effort === undefined ? ok('没有 resolveModelInfo 时不带 reasoningEffort') : bad('没有 resolveModelInfo 时不带 reasoningEffort', String(effort));
}
{
  const failure = extractFailure([JSON.stringify({ type: 'finish', reason: { kind: 'error', failure: { code: 'auth', message: '无效 key' } } })]);
  failure === 'auth: 无效 key' ? ok('从 finish 块抠出失败原因') : bad('从 finish 块抠出失败原因', failure);
}

// 8b. max_tokens 太小时不透传：引擎连通性测试发 1，推理型模型会把这点预算全花在
//     推理上然后交回空正文，表现为「模型没配好」。抬到 64 也不够，所以要整条丢掉。
{
  let seen = null;
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low', name: '低' }] } }; },
    async *stream(params) {
      seen = params;
      yield { type: 'text-delta', text: 'pong' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const b = createLlmBridge({ getLlm: () => llm, getRoute: async () => ({ provider: 'p', model: 'm' }), log: () => {} });
  await b.start();
  const res = await request(b.origin, b.token, '/v1/chat/completions', {
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });
  const okBody = res.status === 200 && res.body.choices[0].message.content === 'pong';
  okBody ? ok('max_tokens=1 被忽略，正文能拿到') : bad('max_tokens=1 被忽略', `${res.status} ${JSON.stringify(res.body)}`);
  (seen && !('maxTokens' in seen))
    ? ok('太小的 max_tokens 不透传给宿主')
    : bad('太小的 max_tokens 不透传给宿主', JSON.stringify(seen && seen.maxTokens));
  b.stop();
}
{
  // 正常值要原样透传，否则引擎按字数要求控制输出长度的能力就丢了
  let seen = null;
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low', name: '低' }] } }; },
    async *stream(params) {
      seen = params;
      yield { type: 'text-delta', text: 'pong' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const b = createLlmBridge({ getLlm: () => llm, getRoute: async () => ({ provider: 'p', model: 'm' }), log: () => {} });
  await b.start();
  await request(b.origin, b.token, '/v1/chat/completions', {
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 4096,
  });
  (seen && seen.maxTokens === 4096)
    ? ok('正常的 max_tokens 原样透传')
    : bad('正常的 max_tokens 原样透传', JSON.stringify(seen && seen.maxTokens));
  b.stop();
}

// 9. 只绑本机
{
  const host = new URL(origin).hostname;
  host === '127.0.0.1' ? ok('只绑 127.0.0.1') : bad('只绑 127.0.0.1', host);
}

bridge.stop();
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
