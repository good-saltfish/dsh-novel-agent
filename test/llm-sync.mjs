// 回归测试：引擎重启后 token 对不上，插件要自动重下发而不是让用户吃 401。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = path.join(os.tmpdir(), 'ns-llmsync');
fs.rmSync(tmpRoot, { recursive: true, force: true });
const appData = path.join(tmpRoot, 'appdata');
const workspace = path.join(tmpRoot, 'workspace');
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({ workspace }, null, 2), 'utf8');
process.env.APPDATA = appData;

const host = await import('../lib/host.js');
const { PanelProcess, StudioError } = host.__testing;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const llm = {
  async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }; },
  async listProviders() { return [{ id: 'deepseek-account', name: 'DeepSeek' }]; },
  async listConfigurableProviders() { return []; },
  async listModels() { return [{ id: 'deepseek-flash', name: 'deepseek-flash' }]; },
  async *stream() { yield { type: 'text-delta', text: '{"ok":true}' }; },
};
const agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) };

const ctx = {
  webServer: { register: () => () => {} },
  connection: { requestRejection: () => undefined },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  inject: (_names, cb) => { cb({ tools: null }); },
  llm,
  agentDefaultModel,
};

// 手动装桥与路由：apply 会注册 webServer，这里只借它把模块级 hostCtx/llmBridge 初始化
host.apply(ctx);

const panel = new PanelProcess(workspace);
const origin = await panel.ensureStarted();
check('引擎起来', typeof origin === 'string', origin);

// 引擎自带 panel 访问令牌：从插件启动时一定带着，直连引擎的请求必须自己补上。
const tokenHeader = { 'x-ndecon-token': panel.panelToken };
const engineGet = async (tail) => (await fetch(`${origin}${tail}`, { headers: tokenHeader })).json();
const enginePost = async (tail, body) =>
  (
    await fetch(`${origin}${tail}`, {
      method: 'POST',
      headers: { ...tokenHeader, 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
  ).json();

// 1) 正常下发后引擎配置应与桥一致
let settings = await engineGet('/api/llm/settings');
check('引擎配置指向桥', settings.base_url.includes('/v1'), settings.base_url);
check('引擎配置是 custom', settings.provider === 'custom', settings.provider);
check('引擎配置有 key', settings.has_key === true);

// 2) 模拟「引擎重启后 token 丢了」：把引擎的 key 改成一个必然错误的串
await fetch(`${origin}/api/llm/settings`, {
  method: 'PUT',
  headers: { ...tokenHeader, 'content-type': 'application/json' },
  body: JSON.stringify({
    provider: 'custom',
    base_url: settings.base_url,
    api_key: 'stale-token-that-does-not-match',
    model: settings.model,
  }),
});
const broken = await enginePost('/api/llm/test', {});
check('旧 token 确实会被桥拒绝（复现用户的 401）', broken.ok === false && String(broken.detail).includes('401'), JSON.stringify(broken).slice(0, 160));

// 3) 自愈：_syncLlmSettings 应该发现不一致并重新下发
await panel._syncLlmSettings();
const healed = await enginePost('/api/llm/test', {});
check('_syncLlmSettings 之后能正常调用', healed.ok === true, JSON.stringify(healed).slice(0, 160));
check('自愈后仍然指向同一个桥', (await engineGet('/api/llm/settings')).base_url === settings.base_url);

panel.stop();
host.__testing.stopAllPanels();
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
