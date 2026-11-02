/**
 * 「用 DSH 的模型」端到端验证：引擎 → 桥 → 宿主 llm 服务。
 *
 * 不连真模型：用假的 `llm` 服务替身，走真实的 ndecon 引擎进程。
 * 验的是链路能不能通、模型选择改没改到引擎里、没选模型时会不会如实报错。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const host = await import('../lib/host.js');
const { panelFor, stopAllPanels } = host.__testing;

let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };
const bad = (name, detail) => { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); };

/* 假宿主：只有 webServer / connection / effect / inject，外加 llm 与 agentDefaultModel。 */
function fakeCtx({ withLlm = true, withDefault = true } = {}) {
  let handler = null;
  const llmCalls = [];
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }] } }; },
    async listProviders() { return [{ id: 'deepseek', name: 'DeepSeek' }]; },
    async listConfigurableProviders() { return []; },
    async listModels(providerId) { return providerId === 'deepseek' ? [{ id: 'deepseek-v4.1-flash', name: 'V4.1 Flash' }] : []; },
    async *stream(params) {
      llmCalls.push(params);
      yield { type: 'text-delta', text: '{"ok":true}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const defaultModel = {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
  };
  const ctx = {
    webServer: {
      register(spec) { handler = spec.handler; return () => { handler = null; }; },
    },
    connection: { requestRejection: () => null },
    effect(fn) { fn(); return () => {}; },
    inject(_names, cb) { cb({ tools: null }); },
  };
  if (withLlm) ctx.llm = llm;
  if (withDefault) ctx.agentDefaultModel = defaultModel;
  return { ctx, getHandler: () => handler, llmCalls };
}

/** 起一个本地 http 服务，把请求交给插件的 handler。 */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function call(origin, method, tail, body) {
  const response = await fetch(`${origin}/novel-studio/api/${tail}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

const dataRoot = path.join(os.tmpdir(), 'novel-studio-model-test-' + Date.now());
const workspace = path.join(dataRoot, 'ws');
await fs.mkdir(workspace, { recursive: true });

const { ctx, getHandler, llmCalls } = fakeCtx();
host.apply(ctx);
const { server, origin } = await serve(getHandler());

// 1. 状态里要能看到模型来自 DSH
{
  const { status, body } = await call(origin, 'GET', '_status');
  const value = body && body.value;
  status === 200 && value.hasModel === true
    ? ok('_status 报 hasModel=true（模型来自 DSH）')
    : bad('_status 报 hasModel=true', `status=${status} ${JSON.stringify(value)}`);
  value && value.model && value.model.model === 'deepseek-v4.1-flash'
    ? ok('_status 报出当前模型 id')
    : bad('_status 报出当前模型 id', JSON.stringify(value && value.model));
}

// 2. 模型列表
{
  const { status, body } = await call(origin, 'GET', '_models');
  const value = body && body.value;
  const providers = (value && value.providers) || [];
  status === 200 && providers.some((p) => p.id === 'deepseek')
    ? ok('_models 列出 DSH 的供应商')
    : bad('_models 列出 DSH 的供应商', `status=${status} ${JSON.stringify(providers)}`);
  const ds = providers.find((p) => p.id === 'deepseek');
  ds && ds.models.some((m) => m.id === 'deepseek-v4.1-flash')
    ? ok('_models 列出该供应商的模型')
    : bad('_models 列出该供应商的模型', JSON.stringify(ds));
  value && value.current && value.current.source === 'default'
    ? ok('当前来源是「跟随 DSH 默认」')
    : bad('当前来源是「跟随 DSH 默认」', JSON.stringify(value && value.current));
}

// 3. 单独指定模型（写 settings 并刷新）
{
  const { status, body } = await call(origin, 'PUT', '_models', { provider: 'deepseek', model: 'deepseek-v4.1-flash' });
  const value = body && body.value;
  status === 200 && value && value.current && value.current.source === 'saved'
    ? ok('PUT _models 存成「本插件单独选」')
    : bad('PUT _models 存成「本插件单独选」', `status=${status} ${JSON.stringify(body)}`);
}
{
  const { status } = await call(origin, 'PUT', '_models', { provider: 'deepseek' });
  status === 400 ? ok('只填 provider 不填 model 被拒 400') : bad('只填 provider 不填 model 被拒 400', `status=${status}`);
}
{
  const { status, body } = await call(origin, 'PUT', '_models', { provider: '', model: '' });
  const value = body && body.value;
  status === 200 && value && value.current && value.current.source === 'default'
    ? ok('清空后回到「跟随 DSH 默认」')
    : bad('清空后回到「跟随 DSH 默认」', `status=${status} ${JSON.stringify(body)}`);
}

// 4. 真链路：起引擎 → 引擎拿到的 LLM 设置应指向桥 → 让引擎测连通性
{
  const panel = panelFor(workspace);
  let started;
  try {
    started = await panel.ensureStarted();
  } catch (error) {
    bad('引擎能起来', String(error && error.message));
  }
  if (started) {
    ok('引擎能起来');
    const settings = await call(origin, 'GET', `projects`); // 触发引擎就绪
    void settings;
    const engineUrl = panel.origin;
    const llm = await fetch(`${engineUrl}/api/llm/settings`).then((r) => r.json());
    llm && llm.provider === 'custom'
      ? ok('引擎的 LLM 设置被改成 custom（指向模型桥）')
      : bad('引擎的 LLM 设置被改成 custom', JSON.stringify(llm));
    llm && typeof llm.base_url === 'string' && llm.base_url.includes('/v1')
      ? ok('引擎 base_url 指向桥的 /v1')
      : bad('引擎 base_url 指向桥的 /v1', JSON.stringify(llm && llm.base_url));

    // 让引擎自己发起一次连通性测试：它会真的 POST 到桥，桥再转给假 llm。
    const test = await fetch(`${engineUrl}/api/llm/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => r.json());
    test && test.ok === true
      ? ok('引擎经桥连通性测试通过（引擎→桥→宿主 llm 真跑通）')
      : bad('引擎经桥连通性测试通过', JSON.stringify(test));
    llmCalls.length > 0
      ? ok(`宿主 llm.stream 被真实调用 ${llmCalls.length} 次`)
      : bad('宿主 llm.stream 被真实调用', String(llmCalls.length));
    const first = llmCalls[0];
    first && first.reasoningEffort === 'low'
      ? ok('桥传了最低推理档（避免输出被推理吃光）')
      : bad('桥传了最低推理档', JSON.stringify(first && first.reasoningEffort));
  }
  panel.stop();
}

// 5. 没有 llm 服务时：如实报没有模型，绝不假装有
{
  const solo = fakeCtx({ withLlm: false, withDefault: false });
  host.apply(solo.ctx);
  const served = await serve(solo.getHandler());
  const { body } = await call(served.origin, 'GET', '_status');
  const value = body && body.value;
  value && value.hasModel === false
    ? ok('宿主没有 llm 时 hasModel=false（不假装有模型）')
    : bad('宿主没有 llm 时 hasModel=false', JSON.stringify(value && value.hasModel));
  served.server.close();
}

stopAllPanels();
server.close();
await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
