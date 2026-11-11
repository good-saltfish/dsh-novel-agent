'use strict';

/**
 * Python 解释器探测与 ndecon CLI 调用。
 *
 * 为什么不用裸名 `ndecon`：本机 `pip show novel-deconstruct` 报 0.1.0，而源码
 * `pyproject.toml` 是 0.2.0 —— 入口脚本装的是旧元数据，新子命令（context /
 * chapter / run / summarize）只有 `python -m ndecon.cli` 才走得到源码。
 *
 * 为什么候选表要按顺序试跑而不是只看 `where`：Windows 上 `python3` 常常是
 * Microsoft Store 的占位程序，存在、可执行、但退出码 49；`py -3` 在没装
 * launcher 的机器上直接不存在。只有真跑一次 `-c ""` 才算数。
 */

import { spawn } from 'node:child_process';

/**
 * 候选解释器。每一项都是完整 argv 前缀，不含 ndecon 参数。
 *
 * 只列系统通用的启动方式，绝不写死任何绝对路径 —— 别人机器上的 Python
 * 在哪装、装没装，只能靠真跑一遍去问。想指定解释器请走设置里的 python 字段
 * （见 resolvePython 的 explicit 参数）。
 */
const CANDIDATES = [
  ['python'],
  ['py', '-3'],
  ['python3'],
];

/** 探测缓存：同一进程里只真跑一次。 */
let cached = null;

/**
 * 跑一个短命令并收集输出。
 *
 * 不用 `execSync`：它会阻塞宿主事件循环，而宿主是同源的 Web 服务，
 * 一次 800ms 的 Python 冷启动会把右栏所有请求一起卡住。
 */
export function runCommand(argv, options = {}) {
  const { cwd, timeoutMs = 20000, env } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(error && error.message), spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({
      ok: false, code: null, stdout, stderr: stderr + String(error && error.message), spawnError: true,
    }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出 */ }
        finish({ ok: false, code: null, stdout, stderr: stderr + `[timeout after ${timeoutMs}ms]`, timedOut: true });
      }, timeoutMs);
    }
  });
}

/**
 * 找出一个真能跑的 Python。
 *
 * 返回 `{ argv, version }`，`argv` 是解释器 argv 前缀；找不到返回 null。
 * 判定标准是「真跑一次并拿到退出码 0」，不是「文件存在」。
 *
 * `options.explicit` 是用户在设置里填的解释器绝对路径，优先于候选表；
 * 它探测失败也不抛错，直接回落到候选表（用户填错了不该把插件卡死）。
 */
export async function resolvePython(options = {}) {
  const { force = false, cwd, explicit } = options;
  if (cached && !force) return cached;
  const candidates = explicit ? [[explicit], ...CANDIDATES] : CANDIDATES;
  for (const candidate of candidates) {
    const probe = await runCommand([...candidate, '-c', ''], { cwd, timeoutMs: 8000 });
    if (!probe.ok) continue;
    const version = await runCommand([...candidate, '--version'], { cwd, timeoutMs: 8000 });
    if (!version.ok) continue;
    cached = { argv: candidate, version: version.stdout.trim() || version.stderr.trim() };
    return cached;
  }
  cached = null;
  return null;
}

/** 清掉探测缓存（设置页改了解释器路径后要重新探）。 */
export function resetPythonCache() {
  cached = null;
}

/**
 * 调 ndecon CLI 一次，返回 `{ ok, code, stdout, stderr, parsed }`。
 *
 * `parsed` 只在 `--json` 类命令且 stdout 能解析时给，避免调用方到处 try/catch。
 */
export async function runNdecon(pythonArgv, args, options = {}) {
  const { cwd, timeoutMs = 60000, env } = options;
  if (!pythonArgv) {
    return { ok: false, code: null, stdout: '', stderr: 'python interpreter not found', parsed: null };
  }
  const result = await runCommand([...pythonArgv, '-m', 'ndecon.cli', ...args], { cwd, timeoutMs, env });
  let parsed = null;
  if (result.ok && result.stdout.trim()) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
  }
  return { ...result, parsed };
}

/** ndecon 版本探测：拿不到就返回 null，由调用方决定怎么降级。 */
export async function detectNdeconVersion(pythonArgv, cwd) {
  const result = await runNdecon(pythonArgv, ['version'], { cwd, timeoutMs: 15000 });
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}
