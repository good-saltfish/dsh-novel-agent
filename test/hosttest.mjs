/**
 * Host 半边的冒烟测试（不依赖 DSH 宿主，直接调 lib/host.js 的纯逻辑）。
 *
 * 跑法：node test/hosttest.mjs
 *
 * 这里只测能在进程内验证的东西：python 探测、panel 子进程的起停、透传路由。
 * 右栏 UI 只能靠人工点（Client 半边的注册契约在真宿主里才成立）。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
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

const { resolvePython, resetPythonCache, runNdecon } = await import('../lib/python.js');

await test('python 探测能拿到一个可跑的解释器', async () => {
  resetPythonCache();
  const python = await resolvePython({});
  assert.ok(python, '未找到 python');
  assert.ok(Array.isArray(python.argv) && python.argv.length > 0);
  assert.match(python.version || '', /Python \d+\.\d+/);
});

await test('ndecon CLI 可调用（version 子命令）', async () => {
  const python = await resolvePython({});
  const result = await runNdecon(python.argv, ['version'], { cwd: process.cwd() });
  assert.equal(result.ok, true, `退出码 ${result.code}：${result.stderr}`);
  assert.match(result.stdout, /0\.\d+\.\d+/);
});

await test('找不到 ndecon 时给出可读的错误，而不是空对象', async () => {
  const { __testing } = await import('../lib/host.js');
  const panel = new __testing.PanelProcess(path.join(os.tmpdir(), 'novel-studio-empty-ws'));
  try {
    // 工作区存在但 ndecon 装没装都可能：要么起来，要么抛 StudioError。
    const origin = await panel.ensureStarted();
    assert.ok(origin, 'ensureStarted 返回了空值');
  } catch (error) {
    assert.equal(error.name, 'StudioError', `抛出的不是 StudioError：${error}`);
    assert.ok(error.code && error.status >= 400, 'StudioError 缺 code/status');
    assert.ok(error.message.length > 10, '错误信息太短，用户看不懂');
  } finally {
    panel.stop();
  }
});

/* -------------------------------------------------------------------------- */
/* panel 子进程 + 透传                                                         */
/* -------------------------------------------------------------------------- */

const workspace = path.join(os.tmpdir(), 'novel-studio-hosttest');
await fs.mkdir(workspace, { recursive: true });

await test('panel 子进程能起来，/api/health 通', async () => {
  const { __testing } = await import('../lib/host.js');
  const panel = new __testing.PanelProcess(workspace);
  try {
    const origin = await panel.ensureStarted();
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.ok, true);
    const body = await response.json();
    assert.equal(body.ok, true);
    panel.stop();
  } finally {
    panel.stop();
  }
});

await test('ensureStarted 幂等：并发调用只起一个进程', async () => {
  const { __testing } = await import('../lib/host.js');
  const panel = new __testing.PanelProcess(workspace);
  try {
    const [a, b, c] = await Promise.all([
      panel.ensureStarted(), panel.ensureStarted(), panel.ensureStarted(),
    ]);
    assert.equal(a, b);
    assert.equal(b, c);
    const status = await panel.status();
    assert.equal(status.running, true);
  } finally {
    panel.stop();
  }
});

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
