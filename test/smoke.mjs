/**
 * Host 半边接线测试：用假 ctx 把 `apply()` 跑起来，打真实 HTTP 请求。
 *
 * 为什么要有这一层：`test/hosttest.mjs` 只测到 PanelProcess，测不到
 * `webServer.register` 的 handler、栅栏、透传与错误体。这层用 Node 自带
 * http 起一个端口，把 handler 挂上去，于是「右栏点一下会发什么请求、
 * 会拿回什么」可以在没有 DSH 宿主的情况下验证。
 *
 * 跑法：node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`  FAIL ${name}\n       ${error && error.message}`);
  }
}

const workspace = path.join(os.tmpdir(), 'novel-studio-smoke-ws');
await fs.mkdir(workspace, { recursive: true });

/** 最小的 ctx 替身：只实现 host.js 真正用到的那几项。 */
function fakeCtx(registrations) {
  return {
    webServer: {
      register(spec) {
        registrations.push(spec);
        return () => { /* unregister */ };
      },
    },
    connection: {
      requestRejection() { return undefined; },
    },
    effect(fn) { return fn(); },
    inject(_names, cb) { cb({ tools: null }); },
  };
}

const { apply } = await import('../lib/host.js');

const registrations = [];
apply(fakeCtx(registrations));
assert.equal(registrations.length, 1, '应当注册一条路由');
assert.equal(registrations[0].kind, 'prefix');
assert.equal(registrations[0].path, '/novel-studio/api');

/** 把注册的 handler 挂到一个真 HTTP 服务上。 */
const server = http.createServer((req, res) => registrations[0].handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function get(tail, options = {}) {
  const response = await fetch(`${base}${tail}`, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

await test('_status 在引擎未启动时也返回 200（设置页要能看见状态）', async () => {
  const { status, body } = await get('/novel-studio/api/_status');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.value.workspace, 'string');
  assert.equal(body.value.running, false);
});

await test('_settings GET 返回当前工作区', async () => {
  const { status, body } = await get('/novel-studio/api/_settings');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.value.workspace, /\.ndecon-workspace$/);
});

await test('跨站请求被栅栏拒绝（403 + 结构化错误体）', async () => {
  const { status, body } = await get('/novel-studio/api/projects', {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(status, 403);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'forbidden');
});

await test('透传 /projects：引擎起来后返回 ndecon 的项目数组', async () => {
  const { status, body } = await get('/novel-studio/api/projects');
  assert.equal(status, 200, `实际 ${status}：${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body), `期望数组，实际 ${typeof body}`);
});

await test('透传未知路径：ndecon 的错误体原样透出（不被插件改写）', async () => {
  // 设计是「透传不改写响应体」——ndecon 的错误形状是 {"error":"项目不存在"}，
  // 插件的 {ok:false,error:{code,message}} 只用于插件自有端点与栅栏。
  const { status, body } = await get('/novel-studio/api/projects/does-not-exist');
  assert.equal(status, 404, `实际 ${status}`);
  assert.equal(body.error, '项目不存在');
});

await test('工具注册在缺 tools 服务时安静跳过，不影响路由', async () => {
  // apply() 里 ctx.inject(['tools'], cb) 拿到 tools: null，应当只 warn 不抛。
  assert.equal(registrations.length, 1);
});

/* ------------------------------------------------------------------ */
/* 安全与抗崩溃                                                        */
/*                                                                     */
/* 这一组测的是「坏输入会不会让请求挂死」。挂死比报错严重：报错用户还能  */
/* 重试，挂死只会看到一个永远转圈的界面，而且宿主侧只留一条未捕获异常。  */
/* ------------------------------------------------------------------ */

await test('路径穿越被拒（%2e%2e 编码绕过也不行）', async () => {
  // 用编码形式，因为 URL 规范化会把裸 ../ 提前吃掉，测不到插件自己的闸。
  const { status, body } = await get('/novel-studio/api/%2e%2e%2f%2e%2e%2fproject.json');
  assert.equal(status, 400, `实际 ${status}：${JSON.stringify(body)}`);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'bad-request');
});

await test('反斜杠与盘符路径被拒', async () => {
  const { status, body } = await get('/novel-studio/api/%5Cwindows%5Csystem32');
  assert.equal(status, 400, `实际 ${status}：${JSON.stringify(body)}`);
  assert.equal(body.error.code, 'bad-request');
});

await test('非法百分号编码：返回 400 而不是把请求挂住', async () => {
  const { status, body } = await get('/novel-studio/api/%zz');
  assert.equal(status, 400, `实际 ${status}：${JSON.stringify(body)}`);
  assert.equal(body.ok, false);
});

await test('PUT _settings 传非法 JSON：返回 400 而不是挂住', async () => {
  const response = await fetch(`${base}/novel-studio/api/_settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const body = await response.json();
  assert.equal(response.status, 400, `实际 ${response.status}`);
  assert.equal(body.ok, false);
});

await test('PUT _settings 传非字符串 workspace：返回 400', async () => {
  const response = await fetch(`${base}/novel-studio/api/_settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 123 }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'bad-request');
});

await test('超大请求体被拒（413），不会把内存吃光', async () => {
  // MAX_BODY_BYTES 是 8MiB，这里送 9MiB 的垃圾。
  const big = 'x'.repeat(9 * 1024 * 1024);
  const response = await fetch(`${base}/novel-studio/api/_settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: big }),
  });
  assert.equal(response.status, 413, `实际 ${response.status}`);
  await response.text();
});

await test('assertSafeTail 对合法路径放行', async () => {
  const { assertSafeTail } = await import('../lib/host.js').then((m) => m.__testing);
  assert.equal(assertSafeTail('projects'), 'projects');
  assert.equal(assertSafeTail('projects/creation-x/chapters/3/context'), 'projects/creation-x/chapters/3/context');
  assert.throws(() => assertSafeTail(''), /路径为空/);
  assert.throws(() => assertSafeTail('a/../b'), /非法路径/);
  assert.throws(() => assertSafeTail('C:/windows'), /非法路径/);
  assert.throws(() => assertSafeTail('a b'), /非法字符/);
});

server.close();

const { stopAllPanels } = (await import('../lib/host.js')).__testing;
stopAllPanels();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
// 显式退出：panel 子进程即使 stop 了，句柄回收也可能延迟，别让 CI 挂住。
process.exit(0);
