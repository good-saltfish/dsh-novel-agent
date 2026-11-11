'use strict';

/**
 * 引擎自举：把这个插件依赖的 Python 包（novel-deconstruct）自动装到用户机器上。
 *
 * 为什么必须做这件事：插件本体只有 JS，业务逻辑全在 `python -m ndecon.cli` 里。
 * 原实现对没装引擎的用户只说「请在 novel-deconstruct 里执行 pip install -e .」——
 * 那是对源码作者说的话，对从插件市场点进来的人等于让他去 GitHub 找仓库、装完
 * 再来。实测一个干净的安装里，卡在这一步的人根本走不到面板。
 *
 * 四条设计约束，每一条都是踩出来的：
 *
 * 1. **不重复装**。先探版本，能跑就直接返回。装完再探一次，只以「探得到版本」
 *    作为成功判据 —— pip 说 Successfully installed 也可能装到了另一个解释器里
 *    （比如 py -3 与 python 指向不同的环境），那必须当失败报出来。
 *
 * 2. **代理是这里最大的坑**。Windows 上系统代理写在注册表里，代理进程关了但
 *    注册表还留着时，pip 的每个 HTTPS 请求都会得到
 *    `SSLEOFError(8, 'EOF occurred in violation of protocol')` —— 看起来像证书
 *    或防火墙问题，其实是连到了一个已经没人监听的端口。实测本机就是这种状态。
 *    所以网络类失败要**再试一次并绕开系统代理**（NO_PROXY=*）。反过来也不能一
 *    开始就绕：GFW 环境下用户正是靠代理才连得上 PyPI。
 *
 * 3. **权限失败要降级到 --user**。装到 `C:\Program Files\Python` 的机器上，
 *    不带 --user 必然 Permission denied，而用户看到这句只会以为插件坏了。
 *
 * 4. **绝不自己挑非官方镜像**。换源是供应链决定，不是插件该替用户做的。装不上
 *    就把真实原因和「可以自己设 PIP_INDEX_URL」说清楚，由用户决定。
 */

import { runCommand } from './python.js';

/** 单次 pip 安装的最长等待。真机实测从零装 pydantic+typer+httpx 约 20–60s。 */
const INSTALL_TIMEOUT_MS = 300000;

/** 包名：与引擎 pyproject.toml 的 `[project] name` 必须一致。 */
const PACKAGE_NAME = 'novel-deconstruct';

/**
 * PyPI 装不上时的备用下载地址。
 *
 * 为什么需要它：PyPI 在某些网络里整片不可达，而 GitHub Release 常常还能下
 * ——两个站点走的是不同的 CDN 与不同的封锁名单。没有这条兜底，那些用户看到
 * 的只有「连不上 PyPI，请自己设 PIP_INDEX_URL」，等于把一件插件本该自己解决
 * 的事推回给他。
 *
 * 文件名刻意不带版本号：`releases/latest/download/<固定名>` 只在请求时解析
 * latest，一旦文件名里带版本，下次发版这个链接就静默 404 了。发版工作流
 * （`.github/workflows/release.yml`）会额外上传一份固定名的 wheel 来喂这里。
 */
const FALLBACK_WHEEL_URL =
  'https://github.com/good-saltfish/novel-deconstruct/releases/latest/download/novel-deconstruct-py3-none-any.whl';

/**
 * 同一进程内同一个解释器只装一次。
 *
 * 不缓存的话，用户连点几次「重启引擎」会并发跑好几个 pip，pip 自己会锁冲突
 * 报出 `Could not install packages due to an OSError`，看起来像磁盘坏了。
 */
const installs = new Map();

/** pip 输出里能认出来的失败类别 → 给用户的下一步。 */
const FAILURE_HINTS = [
  {
    kind: 'proxy',
    test: /SSL|EOF occurred in violation of protocol|ProxyError|Tunnel connection failed|CERTIFICATE_VERIFY/i,
    hint:
      '连 PyPI 的 HTTPS 被挡了。最常见的原因是系统里登记了一个已经关掉的代理：' +
      '设置 → 网络和 Internet → 代理，把「使用代理服务器」关掉，或改成正在运行的那个。',
  },
  {
    kind: 'permission',
    test: /Permission denied|Access is denied|WinError 5|Errno 13|not writeable|Consider using the `--user`/i,
    hint: '没有写出权限。这一般发生在装在 Program Files 下的 Python 上；插件会自己再用 --user 装一次。',
  },
  {
    kind: 'network',
    test: /Could not find a version|No matching distribution|Max retries exceeded|name resolution|getaddrinfo|Network is unreachable/i,
    hint:
      '连不上 PyPI。插件会先绕开系统代理、再从官方 GitHub Release 下载同一份安装包各试一次；' +
      '如果都不行，可以自己设 PIP_INDEX_URL 指向可用的索引，或者手动执行 ' +
      '`python -m pip install -U novel-deconstruct -i https://pypi.tuna.tsinghua.edu.cn/simple`。',
  },
  {
    kind: 'no-pip',
    test: /No module named pip|pip: command not found|unknown option/i,
    hint: '这个 Python 里没有 pip。插件会先试 `python -m ensurepip`，如果也失败，请重装 Python 并勾选 pip。',
  },
];

/** 安装过后的统计信息，交给 /status 展示。 */
function newState() {
  return {
    /** idle | installing | installed | failed */
    state: 'idle',
    /** 本次尝试走到第几步（1 起）。 */
    attempt: 0,
    /** 最后一次失败类别（proxy/permission/network/no-pip），成功时为 null。 */
    reason: null,
    /** 给用户看的下一步。 */
    hint: null,
    /** 最后一次尝试的退出码与输出尾巴（已限长，交给上层脱敏）。 */
    code: null,
    output: '',
    /** 成功时装上的版本。 */
    version: null,
    at: null,
  };
}

/**
 * pip 的输出又长又吵，只留最后几行有信息量的。
 *
 * 不能只留最后一行：`ERROR: Could not find a version...` 后面往往还跟一行
 * `ERROR: No matching distribution found`，前一行才是原因。
 */
function tailOutput(text, limit = 1200) {
  const raw = String(text || '').trim();
  if (raw.length <= limit) return raw;
  return `…${raw.slice(-limit)}`;
}

/** 从 pip 输出里认出失败类别，返回 `{ kind, hint }`。 */
function classifyFailure(output) {
  for (const rule of FAILURE_HINTS) {
    if (rule.test.test(output)) return { kind: rule.kind, hint: rule.hint };
  }
  return { kind: 'unknown', hint: '安装没有成功，原因见下面的输出。' };
}

/**
 * 跑一次 `pip install`。
 *
 * `options.bypassProxy` 会把 NO_PROXY 设成 `*`：requests（pip 的底座）读这个
 * 变量就不再走系统代理。只设 NO_PROXY 不动 HTTP(S)_PROXY，用户自己配的代理
 * 在下一轮里还能用上。
 *
 * `options.run` 是测试注入点，默认就是真的 spawn。有了它，安装流程的
 * 分支（代理失败 → 绕代理、权限失败 → --user）才能在几毫秒里验证完，
 * 而不是每次真去 PyPI 跑五分钟。
 */
async function pipInstall(
  pythonArgv,
  { user = false, bypassProxy = false, run = runCommand, target = PACKAGE_NAME } = {},
) {
  const args = ['-m', 'pip', 'install', '--upgrade', '--no-input', '--progress-bar', 'off'];
  if (user) args.push('--user');
  args.push(target);
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  if (bypassProxy) {
    env.NO_PROXY = '*';
    env.no_proxy = '*';
  }
  const result = await run([...pythonArgv, ...args], { timeoutMs: INSTALL_TIMEOUT_MS, env });
  const output = tailOutput(`${result.stdout || ''}\n${result.stderr || ''}`);
  return { ...result, output };
}

/** ensurepip：有的发行版把 pip 剥掉了，`python -m pip` 直接报 No module named pip。 */
async function ensurePip(pythonArgv, run = runCommand) {
  const probe = await run([...pythonArgv, '-m', 'pip', '--version'], { timeoutMs: 20000 });
  if (probe.ok) return true;
  const boot = await run([...pythonArgv, '-m', 'ensurepip', '--upgrade'], { timeoutMs: 120000 });
  if (!boot.ok) return false;
  const again = await run([...pythonArgv, '-m', 'pip', '--version'], { timeoutMs: 20000 });
  return again.ok;
}

/**
 * 按「先原样、再降级」的顺序装一次，返回最终状态。
 *
 * 顺序是刻意排的：每一轮只改一个变量，这样最后报出来的 reason 能指认到底是
 * 权限问题还是网络问题，而不是「反正试了几种都不行」。
 *
 * @param {string[]} pythonArgv 解释器 argv 前缀
 * @param {{ onProgress?: (state: object) => void }} options
 */
async function installOnce(pythonArgv, options = {}) {
  const { onProgress, run = runCommand } = options;
  const state = newState();
  const report = () => {
    if (typeof onProgress === 'function') {
      try {
        onProgress({ ...state });
      } catch {
        /* 进度回调失败不该让安装失败 */
      }
    }
  };

  state.state = 'installing';
  state.at = new Date().toISOString();

  if (!(await ensurePip(pythonArgv, run))) {
    state.state = 'failed';
    state.reason = 'no-pip';
    state.hint = FAILURE_HINTS.find((rule) => rule.kind === 'no-pip').hint;
    report();
    return state;
  }

  /**
   * 第一轮永远按用户环境原样装。
   *
   * 不能一开始就加 --user 或绕代理：GFW 后面的用户正是靠系统代理才连得上 PyPI，
   * 默认绕代理等于把他唯一的通路堵死；而装到用户目录会改变包的可见范围，
   * 只在确实没权限时才该这么做。
   *
   * 三轮上限，每轮换且只换一个变量：
   *   1) 原样装 PyPI 包名
   *   2) 依失败类别降级：没权限 → --user；代理/网络 → 绕代理
   *   3) 前两轮都卡在网络时，改从 GitHub Release 下 wheel
   * 第三轮存在的理由：PyPI 与 GitHub 是不同的 CDN、不同的封锁名单，一边整片
   * 不可达时另一边常常还能用。这轮只在「已经排除了权限问题」时才走。
   */
  let round = { user: false, bypassProxy: false, target: PACKAGE_NAME };
  for (let index = 0; index < 3; index += 1) {
    state.attempt = index + 1;
    report();
    const result = await pipInstall(pythonArgv, { ...round, run });
    state.code = result.code;
    state.output = result.output;
    if (result.ok) {
      state.state = 'installed';
      state.reason = null;
      state.hint = null;
      report();
      return state;
    }
    const failed = classifyFailure(result.output);
    state.reason = failed.kind;
    state.hint = failed.hint;
    report();
    if (failed.kind === 'permission') {
      round = { user: true, bypassProxy: false, target: PACKAGE_NAME };
    } else if (failed.kind === 'proxy' || failed.kind === 'network') {
      // 第二轮先绕代理；已经绕过还不行（index>=1），才换 GitHub 这条路。
      // 反过来先换源再绕代理会在「代理是唯一通路」的机器上白跑一轮。
      if (index >= 1 && round.target === PACKAGE_NAME) {
        round = { user: round.user, bypassProxy: true, target: FALLBACK_WHEEL_URL };
        state.hint = 'PyPI 走不通，正在改从 GitHub 下载安装包再试。';
      } else {
        round = { user: false, bypassProxy: true, target: PACKAGE_NAME };
      }
    } else break;
  }

  state.state = 'failed';
  report();
  return state;
}

/**
 * 确保引擎可用；缺就装。
 *
 * 返回值一律是状态对象（不抛错）：调用方要把「装不上」当成一种业务结果渲染
 * 给用户看，而不是变成一次 500。
 *
 * @param {{ pythonArgv: string[], detect: (argv: string[]) => Promise<string|null>,
 *           onProgress?: (state: object) => void, force?: boolean }} options
 */
export async function ensureEngine(options) {
  const { pythonArgv, detect, onProgress, force = false, run = runCommand } = options;
  const key = pythonArgv.join('\u0000');

  const existing = await detect(pythonArgv);
  if (existing) {
    const done = { ...newState(), state: 'installed', version: existing };
    return { ...done, alreadyPresent: true };
  }

  if (!force && installs.has(key)) return installs.get(key);

  const task = (async () => {
    const installed = await installOnce(pythonArgv, { onProgress, run });
    if (installed.state !== 'installed') return installed;
    // 只认「装完真能探到版本」：pip 可能把包装进了另一个解释器（py -3 与
    // python 指向不同环境时很常见），也可能装上了但入口模块缺失。
    const version = await detect(pythonArgv);
    if (!version) {
      return {
        ...installed,
        state: 'failed',
        reason: 'not-visible',
        hint:
          '装着装着成功了，但这个解释器里仍然找不到 ndecon。' +
          '常见原因是 pip 与 python 不是同一个环境；在设置里填上解释器的绝对路径再试。',
      };
    }
    return { ...installed, version };
  })();

  installs.set(key, task);
  try {
    return await task;
  } finally {
    // 失败的不留缓存，下次点重试要真的重跑；成功的也删掉——
    // 成功路径靠上面的 detect 短路，不需要占缓存。
    installs.delete(key);
  }
}

/** 装过之后想重来（设置里换了 python 解释器）时清缓存。 */
export function resetInstallCache() {
  installs.clear();
}

export const __test = { classifyFailure, tailOutput, PACKAGE_NAME, INSTALL_TIMEOUT_MS };
