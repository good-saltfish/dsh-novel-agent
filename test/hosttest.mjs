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

// 隔离插件数据目录：这个套件会起真实 panel 子进程，不隔离的话
// engine.log / last-exit.json 会写进用户真实的 %APPDATA%\dsh-novel-agent，
// 把排查真实故障用的现场证据冲掉。
process.env.APPDATA = path.join(os.tmpdir(), 'novel-studio-hosttest-appdata');
await fs.mkdir(path.join(process.env.APPDATA, 'dsh-novel-agent'), { recursive: true });

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

/**
 * stdout 必须被消费，否则子进程会死锁。
 *
 * 实测（_scratch/stdout-deadlock.mjs）：无人读的 pipe 写满约 64KB 后 write
 * 阻塞，进程永久卡住且不报错。这里用一个狂打 stdout 的假引擎验证
 * 「插件的 spawn 写法本身不会把子进程憋死」——即使真引擎以后加进度打印。
 */
await test('stdout 狂写的子进程不会被憋死（管道有人读）', async () => {
  const { spawn } = await import('node:child_process');
  const python = await resolvePython({});
  const script = [
    'import sys',
    'for i in range(3000):',
    '    sys.stdout.write("x" * 100 + "\\n")',
    'sys.stdout.flush()',
    'sys.stderr.write("DONE\\n")',
    'sys.stderr.flush()',
  ].join('\n');

  const child = spawn(python.argv[0], [...python.argv.slice(1), '-c', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // 完全照抄 host.js 的处理方式：两个管道都有人读。
  let seen = 0;
  child.stdout.on('data', (chunk) => { seen += chunk.length; });
  const finished = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    child.stderr.on('data', (chunk) => {
      if (chunk.toString().includes('DONE')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  child.kill();
  assert.equal(finished, true, `子进程 8s 内没跑完（读到的 stdout 只有 ${seen} 字节），说明管道被憋住`);
  assert.ok(seen > 200000, `stdout 只读到 ${seen} 字节，管道可能被截断`);
});

/* -------------------------------------------------------------------------- */
/* 改名迁移                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 插件从 dsh-novel-studio 改名成 dsh-novel-agent，数据目录也跟着改。
 *
 * 这几条测试存在的唯一原因：老用户的书稿路径存在旧目录的 settings.json 里，
 * 搬迁写错不会报错，只会表现为「打开面板一本都没有」——比崩了还难查。
 */
await test('数据目录用新名，旧名只作迁移来源', async () => {
  const { __testing } = await import('../lib/host.js');
  assert.equal(path.basename(__testing.dataDir()), 'dsh-novel-agent');
  assert.equal(path.basename(__testing.legacyDataDir()), 'dsh-novel-studio');
});

await test('旧版设置会被搬到新目录', async () => {
  const original = process.env.APPDATA;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-migrate-'));
  process.env.APPDATA = root;
  try {
    const { __testing } = await import('../lib/host.js');
    await fs.mkdir(path.join(root, 'dsh-novel-studio'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'dsh-novel-studio', 'settings.json'),
      JSON.stringify({ workspace: 'D:/books', model: { provider: 'x', model: 'y' } }),
      'utf8',
    );

    const moved = await __testing.migrateLegacyData();
    assert.equal(moved, true);
    const pasted = JSON.parse(
      await fs.readFile(path.join(root, 'dsh-novel-agent', 'settings.json'), 'utf8'),
    );
    assert.equal(pasted.workspace, 'D:/books');
    assert.equal(pasted.model.model, 'y');
    // 旧文件必须还在：用户回退到旧版本时设置不能凭空消失。
    assert.ok(await fs.readFile(path.join(root, 'dsh-novel-studio', 'settings.json'), 'utf8'));
  } finally {
    process.env.APPDATA = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test('新目录已有设置时不被旧设置覆盖', async () => {
  const original = process.env.APPDATA;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-migrate-'));
  process.env.APPDATA = root;
  try {
    const { __testing } = await import('../lib/host.js');
    await fs.mkdir(path.join(root, 'dsh-novel-studio'), { recursive: true });
    await fs.mkdir(path.join(root, 'dsh-novel-agent'), { recursive: true });
    await fs.writeFile(path.join(root, 'dsh-novel-studio', 'settings.json'), '{"workspace":"OLD"}', 'utf8');
    await fs.writeFile(path.join(root, 'dsh-novel-agent', 'settings.json'), '{"workspace":"NEW"}', 'utf8');

    const moved = await __testing.migrateLegacyData();
    assert.equal(moved, false);
    const kept = JSON.parse(await fs.readFile(path.join(root, 'dsh-novel-agent', 'settings.json'), 'utf8'));
    assert.equal(kept.workspace, 'NEW');
  } finally {
    process.env.APPDATA = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test('没有旧目录时迁移安静返回 false，不抛错', async () => {
  const original = process.env.APPDATA;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-migrate-'));
  process.env.APPDATA = root;
  try {
    const { __testing } = await import('../lib/host.js');
    assert.equal(await __testing.migrateLegacyData(), false);
  } finally {
    process.env.APPDATA = original;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
