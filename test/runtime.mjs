/**
 * 引擎自举的测试（`lib/runtime.js`）。
 *
 * 跑法：node test/runtime.mjs
 *
 * 这里全部用注入的假 `run` 跑，**不真调 pip**：
 *   - 真装一次要几十秒到几分钟，还要网络，测试跑不动；
 *   - 更要紧的是，真实失败场景（代理挂了、没权限、离线）在正常机器上根本
 *     复现不出来，而这些恰恰是自动安装唯一需要设计的部分。
 *
 * 每个用例都对应一个真机踩过的坑，见各处注释。
 */

import assert from 'node:assert/strict';

const { ensureEngine, resetInstallCache, __test } = await import('../lib/runtime.js');

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

/** 假 run：按 argv 内容决定这次"执行"的结果，并记录调用。 */
function fakeRun(handler) {
  const calls = [];
  const run = async (argv, options) => {
    const record = { argv, options };
    calls.push(record);
    return handler(argv, options, calls);
  };
  run.calls = calls;
  return run;
}

/** 一条成功的 pip 输出。 */
const OK = { ok: true, code: 0, stdout: 'Successfully installed novel-deconstruct-0.2.0', stderr: '' };

/** 系统代理挂了时 pip 的真实报错（本机实测原文）。 */
const PROXY_FAIL = {
  ok: false,
  code: 1,
  stdout: '',
  stderr:
    "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by " +
    "'SSLError(SSLEOFError(8, 'EOF occurred in violation of protocol (_ssl.c:997)'))': /simple/novel-deconstruct/\n" +
    'ERROR: Could not find a version that satisfies the requirement novel-deconstruct (from versions: none)',
};

/** 装在 Program Files 下的 Python 上必然出现的那种报错。 */
const PERMISSION_FAIL = {
  ok: false,
  code: 1,
  stdout: '',
  stderr: "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied: 'D:\\\\Python\\\\Lib\\\\site-packages\\\\pydantic'",
};

await test('已装好时直接返回，不跑 pip', async () => {
  resetInstallCache();
  const run = fakeRun(() => OK);
  const state = await ensureEngine({
    pythonArgv: ['python'],
    detect: async () => '0.2.0',
    run,
  });
  assert.equal(state.state, 'installed');
  assert.equal(state.version, '0.2.0');
  assert.equal(state.alreadyPresent, true);
  assert.equal(run.calls.length, 0, `不该跑任何命令，实际跑了 ${run.calls.length} 次`);
});

await test('没装时先探 pip 再装，成功后回探版本', async () => {
  resetInstallCache();
  const run = fakeRun((argv) => {
    if (argv.includes('--version')) return { ok: true, code: 0, stdout: 'pip 24.0', stderr: '' };
    return OK;
  });
  const state = await ensureEngine({
    pythonArgv: ['python'],
    detect: async (argv) => {
      // 探测解释器时还没装；装完之后要能探到。
      const installed = run.calls.some((c) => c.argv.includes('install'));
      return installed ? '0.2.0' : null;
    },
    run,
  });
  assert.equal(state.state, 'installed');
  assert.equal(state.version, '0.2.0');
  assert.equal(state.reason, null);
});

await test('pip 说装成功了但探不到版本 → 仍然算失败', async () => {
  // 真机场景：`py -3` 与 `python` 指向不同环境，pip 把包装进了另一个解释器。
  // 这时回「装好了」会让用户看到一个永远起不来的面板，比直接报错更差。
  resetInstallCache();
  const run = fakeRun((argv) => {
    if (argv.includes('--version')) return { ok: true, code: 0, stdout: 'pip 24.0', stderr: '' };
    return OK;
  });
  const state = await ensureEngine({
    pythonArgv: ['python'],
    detect: async () => null, // 永远探不到
    run,
  });
  assert.equal(state.state, 'failed');
  assert.equal(state.reason, 'not-visible');
  assert.ok(/绝对路径/.test(state.hint), '提示要告诉用户去设置里填解释器路径');
});

await test('代理挂了 → 第二轮绕开系统代理重试', async () => {
  // 这是本机实测的状态：注册表里 ProxyEnable=1 指向一个已经没人监听的端口，
  // 于是 pip 每个 HTTPS 请求都报 SSLEOFError。不绕代理，用户永远装不上。
  resetInstallCache();
  let installs = 0;
  const run = fakeRun((argv, options) => {
    if (argv.includes('--version')) return { ok: true, code: 0, stdout: 'pip 24.0', stderr: '' };
    installs += 1;
    if (installs === 1) {
      assert.ok(!options.env?.NO_PROXY, '第一轮不该绕代理：GFW 用户正是靠它连 PyPI');
      return PROXY_FAIL;
    }
    assert.equal(options.env?.NO_PROXY, '*', '第二轮必须设 NO_PROXY=*');
    return OK;
  });
  const state = await ensureEngine({
    pythonArgv: ['python'],
    detect: async () => (installs >= 2 ? '0.2.0' : null),
    run,
  });
  assert.equal(state.state, 'installed');
  assert.equal(state.attempt, 2);
  assert.equal(installs, 2);
});

await test('没权限 → 第二轮加 --user', async () => {
  resetInstallCache();
  let installs = 0;
  const run = fakeRun((argv) => {
    if (argv.includes('--version')) return { ok: true, code: 0, stdout: 'pip 24.0', stderr: '' };
    installs += 1;
    if (installs === 1) {
      assert.ok(!argv.includes('--user'), '第一轮不该用 --user');
      return PERMISSION_FAIL;
    }
    assert.ok(argv.includes('--user'), '第二轮必须加 --user');
    return OK;
  });
  const state = await ensureEngine({
    pythonArgv: ['python'],
    detect: async () => (installs >= 2 ? '0.2.0' : null),
    run,
  });
  assert.equal(state.state, 'installed');
  assert.equal(state.attempt, 2);
});

await test('两轮都失败 → 失败状态带类别与下一步，且不再多试', async () => {
  resetInstallCache();
  const run = fakeRun((argv) => {
    if (argv.includes('--version')) return { ok: true, code: 0, stdout: 'pip 24.0', stderr: '' };
    return PROXY_FAIL;
  });
  const state = await ensureEngine({ pythonArgv: ['python'], detect: async () => null, run });
  assert.equal(state.state, 'failed');
  assert.equal(state.reason, 'proxy');
  assert.ok(/代理/.test(state.hint), '提示里要直接说代理');
  const installs = run.calls.filter((c) => c.argv.includes('install'));
  assert.equal(installs.length, 2, `最多两轮，实际跑了 ${installs.length} 次`);
});

await test('没有 pip 时先试 ensurepip；ensurepip 也失败就报 no-pip', async () => {
  resetInstallCache();
  const run = fakeRun((argv) => {
    if (argv.includes('ensurepip')) return { ok: false, code: 1, stdout: '', stderr: 'ensurepip is not available' };
    return { ok: false, code: 1, stdout: '', stderr: 'No module named pip' };
  });
  const state = await ensureEngine({ pythonArgv: ['python'], detect: async () => null, run });
  assert.equal(state.state, 'failed');
  assert.equal(state.reason, 'no-pip');
  assert.ok(run.calls.some((c) => c.argv.includes('ensurepip')), '应该试过 ensurepip');
});

await test('并发调 ensureEngine 只跑一次 pip', async () => {
  // 用户连点「重启引擎」会并发触发 _boot；不挡的话几个 pip 同时跑，
  // pip 自己的锁冲突会报 OSError，看起来像磁盘坏了。
  resetInstallCache();
  let installs = 0;
  const run = fakeRun(async (argv) => {
    if (argv.includes('--version')) return { ok: true, code: 0, stdout: 'pip 24.0', stderr: '' };
    installs += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return OK;
  });
  const detect = async () => (installs >= 1 ? '0.2.0' : null);
  const [a, b, c] = await Promise.all([
    ensureEngine({ pythonArgv: ['python'], detect, run }),
    ensureEngine({ pythonArgv: ['python'], detect, run }),
    ensureEngine({ pythonArgv: ['python'], detect, run }),
  ]);
  assert.equal(a.state, 'installed');
  assert.equal(b.state, 'installed');
  assert.equal(c.state, 'installed');
  assert.equal(installs, 1, `只该装一次，实际 ${installs} 次`);
});

await test('classifyFailure 认得四种真机报错', async () => {
  const { classifyFailure } = __test;
  assert.equal(classifyFailure(PROXY_FAIL.stderr).kind, 'proxy');
  assert.equal(classifyFailure(PERMISSION_FAIL.stderr).kind, 'permission');
  assert.equal(classifyFailure('Could not find a version that satisfies the requirement x').kind, 'network');
  assert.equal(classifyFailure('No module named pip').kind, 'no-pip');
  assert.equal(classifyFailure('something else entirely').kind, 'unknown');
});

await test('tailOutput 超长只留尾巴且带省略号', async () => {
  const { tailOutput } = __test;
  assert.equal(tailOutput('short'), 'short');
  const long = 'x'.repeat(2000);
  const out = tailOutput(long, 100);
  assert.equal(out.length, 101, `实际 ${out.length}`);
  assert.ok(out.startsWith('…'));
});

const failed = results.filter((r) => !r.ok);
console.log('\n---------------------------------------------');
console.log(`  ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
