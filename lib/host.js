'use strict';

/**
 * 小说工作台插件（Host 半）。
 *
 * 分工：本半边只做三件事 ——
 *   1. 托管一个长驻的 `python -m ndecon.cli panel` 子进程（nd 引擎）；
 *   2. 把 `/novel-studio/api/*` 原样透传给那个子进程，**不解释任何业务字段**；
 *   3. 把写作动作注册成工具，让模型能直接调。
 *
 * 为什么是「托管子进程 + 透传」而不是把 ndecon 重写成 TS：
 * 唯一的真相是 `.ndecon-workspace/projects/<id>/project.json`，panel 进程持有
 * LLMSession 与索引缓存。TS 侧再实现一份，就是两份真相，迟早对不上。
 *
 * 为什么不用宿主的 `subprocess` 服务：它是 abstract 服务（「Subclass,
 * implement spawn」），本机实现细节不可控；Node 自带的 child_process 够用，
 * 且探测解释器、探空闲端口这些事本来就要自己写。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';

import { createLlmBridge, probeModel } from './bridge.js';
import { importFromMarkdown } from './import-md.js';
import { detectNdeconVersion, resetPythonCache, resolvePython, runNdecon } from './python.js';
import { ensureEngine, resetInstallCache } from './runtime.js';
import { registerNovelTools } from './tools.js';

export const name = 'dsh-novel-agent';

/**
 * 服务声明。
 *
 * `llm` 与 `agentDefaultModel` 是「用 DSH 里配好的模型」的前提：前者调模型，
 * 后者读 DSH 当前默认模型选择（provider / model / reasoningEffort）。
 * 这两个**必须显式声明**——cordis 的 fiber ctx 对未注入属性访问会直接抛错，
 * 不声明的话 optionalService 只能吞异常返回 undefined，表现为「模型永远没配好」。
 *
 * 反过来，旧宿主可能没有这两个服务：所以访问一律走 optionalService
 * （每个属性单独 try），拿不到就如实报 hasModel=false，绝不静默假装有模型。
 *
 * `tools` 走 ctx.inject 而不是写在这里：宿主没有 tools 服务时，右栏照样要能用，
 * 不能因为注册不了工具就整个半边挂掉。
 */
export const inject = ['webServer', 'connection', 'llm', 'agentDefaultModel'];

const API_PREFIX = '/novel-studio/api';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 子进程从 spawn 到 /api/health 通的最长等待。Python 冷启动实测 300–800ms。 */
const PANEL_BOOT_TIMEOUT_MS = 12000;
/** 端口被占时的重试次数（换端口重试，不重试同一端口）。 */
const PANEL_PORT_ATTEMPTS = 3;
/**
 * 单次透传请求的等待上限。
 *
 * 必须大于「引擎内部最坏耗时」，否则插件会在引擎还在正常工作时先掐断它。
 * 引擎内部账：provider 单次调用 60s（`openai_compat.py` 的 `timeout=60.0`），
 * 一章最多 1 次生成 + 2 次修复 = 3 次调用 = 180s，再留出摘要与落盘的余量。
 * 所以取 300s：真模型一章 30–120s 是常态，最坏 180s，300s 才够安全。
 */
const PROXY_TIMEOUT_MS = 300000;

/**
 * 透传路径必须落在 ndecon 的 API 空间内，不许借 `..` 或盘符跳出。
 *
 * **必须放行非 ASCII**：ndecon 的项目 ID 规则是 `^[A-Za-z0-9_\-一-鿿]{1,64}$`，
 * 也就是「用中文书名建的项目，ID 里带中文」。早期版本这里只写了 `[A-Za-z0-9_-]`，
 * 结果中文项目建得出来、却点不进去（每个请求都 400），而且报错说「路径含非法
 * 字符」，看起来像用户操作有问题。实测见 _scratch/e2e-feasibility.mjs。
 *
 * 放行范围刻意收窄：除了 ASCII 可见字符，只多允许 `\u4e00-\u9fff`（CJK 统一表意
 * 文字）与 `\u3400-\u4dbf`（扩展 A）。不含空格、引号、反斜杠、冒号——这些仍拒。
 */
const SAFE_TAIL = /^[A-Za-z0-9_\-./%\u3400-\u4dbf\u4e00-\u9fff]+$/;

/* -------------------------------------------------------------------------- */
/* 错误                                                                        */
/* -------------------------------------------------------------------------- */

class StudioError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.status = status == null ? 400 : status;
  }
}

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 插件从 `dsh-novel-studio` 改名成 `dsh-novel-agent`。
 *
 * 数据目录跟着改名，但**老用户的目录不能就当没看见**：里面存的是工作区路径，
 * 丢了就等于「我的书不见了」。所以首次启动时把旧的 settings.json 搬过来（见
 * `migrateLegacyData`）。只搬设置，不搬 logs —— 日志是排查用的，混在一起反而
 * 分不清哪条是改名前的现场。
 */
const DATA_DIR_NAME = 'dsh-novel-agent';
const LEGACY_DATA_DIR_NAME = 'dsh-novel-studio';

function configRoot() {
  if (process.platform === 'win32' && process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
}

/** 插件自己的数据目录：只存「工作区路径」这类插件级设置，不存业务数据。 */
function dataDir() {
  return path.join(configRoot(), DATA_DIR_NAME);
}

const legacyDataDir = () => path.join(configRoot(), LEGACY_DATA_DIR_NAME);

/**
 * 把旧版本留下的 settings.json 搬到新目录。
 *
 * 三条边界：
 * - 新目录已有 settings.json 就**不覆盖**（用户可能已经在新版里改过设置）；
 * - 只有旧文件存在才搬，且搬完保留旧文件（用户回退版本不至于丢设置）；
 * - 失败只记日志，不能让插件起不来 —— 设置读不到还有默认值，起不来就什么都没有。
 */
async function migrateLegacyData() {
  const target = settingsFile();
  const source = path.join(legacyDataDir(), 'settings.json');
  try {
    if (await pathExists(target)) return false;
    if (!(await pathExists(source))) return false;
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.copyFile(source, target);
    console.warn(`[${name}] 已把旧版设置从 ${LEGACY_DATA_DIR_NAME} 迁到 ${DATA_DIR_NAME}`);
    return true;
  } catch (error) {
    console.warn(`[${name}] 旧版设置迁移失败（不影响使用）`, error);
    return false;
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

const settingsFile = () => path.join(dataDir(), 'settings.json');
/** 引擎进程日志目录。内存里留 8192 字符不够用：进程一退出，现场就没了。 */
const logDir = () => path.join(dataDir(), 'logs');
const lastExitFile = () => path.join(logDir(), 'last-exit.json');

/**
 * 把引擎的 stderr/stdout 追加到磁盘。
 *
 * 为什么必须落盘：内存里留的那 8192 字符随 PanelProcess 生命周期存在，
 * 而宿主重启后对象就没了 —— 用户报「无法连接引擎」时，退出码与 stderr
 * 正是唯一能区分「被宿主回收 / 被系统杀掉 / python 抛异常」的证据。
 * 失败一律吞掉：日志写不进去不该把引擎拖下水。
 */
async function appendEngineLog(name, text) {
  if (!text) return;
  try {
    const dir = logDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fs.appendFile(file, text, 'utf8');
    // 单个日志文件封顶 2MB，超了从头截断，避免长跑把磁盘写满。
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) {
      const raw = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, raw.slice(-1024 * 1024), 'utf8');
    }
  } catch {
    /* 日志失败不影响引擎 */
  }
}

/* -------------------------------------------------------------------------- */
/* 文案脱敏                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 抹掉文案里的本机绝对路径，以及 URL 里的路径段。
 *
 * 为什么要在出站这一层抹：`/status` 与 502 会带出引擎的 stderr，里面有
 * `D:\Python\Python310\lib\site-packages\httpx\...`、用户名目录、项目绝对路径。
 * 面板是给用户看进度的，不是运维控制台（前端早就有「不要显示日志路径」的用例），
 * 而这些字段又确实会经由 HTTP 回到浏览器，所以统一在这里过一道。
 *
 * 顺序必须是「先 URL、后 Windows 路径」：反过来 `https://x` 里的 `s:` 会被当成盘符，
 * `https://a.b/c` 会变成 `htt<路径>`。Windows 那条还必须带负向后顾，否则同理。
 */
const URL_PATH_RE = /\b(https?:\/\/[^/\s:"'<>]+)[^\s"'<>]*/g;
const WIN_PATH_RE = /(?<![A-Za-z])[A-Za-z]:[\\/]+(?:[^\\/\s"'<>|,*?:]+[\\/]+)*[^\\/\s"'<>|,*?:]*/g;
const POSIX_PATH_RE = /\/(?:Users|home|root|private|var|opt|tmp)\/[^\s"'<>|,;]*/g;

function scrubPaths(message) {
  if (!message) return '';
  return String(message)
    .replace(URL_PATH_RE, '$1')
    .replace(WIN_PATH_RE, '<路径>')
    .replace(POSIX_PATH_RE, '<路径>');
}

/** 取最后一行非空内容并限长：traceback 的最后一行才是真正的异常。 */
function lastLine(text, limit = 200) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.length ? lines[lines.length - 1] : '';
  return tail.length > limit ? `${tail.slice(0, limit)}…` : tail;
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * 解析工作区目录。
 *
 * 默认落在插件自己的数据目录下（`<dataDir>/workspace`），**不跟随宿主 cwd**。
 *
 * 为什么不能用 `path.resolve('.ndecon-workspace')`：宿主从不同目录启动时 cwd 不同，
 * 同一个插件就会指向不同的书库。实测宿主 cwd 是
 * `C:\Users\<user>\.dsh\profiles\desktop`，右栏打开的是一个空目录，而命令行在项目
 * 根建的书一本都看不见——用户只看到「工作区里还没有项目」，不知道这是两个库。
 *
 * 设置里给了路径就优先用它（`_settings` PUT 写入），要接命令行已有的书库，
 * 填一次绝对路径即可。
 */
async function resolveWorkspace(explicit) {
  const settings = await readJson(settingsFile(), {});
  const raw = explicit || settings.workspace || path.join(dataDir(), 'workspace');
  const abs = path.resolve(raw);
  await fs.mkdir(abs, { recursive: true });
  return abs;
}

/**
 * 数一数工作区里有几个项目。
 *
 * 只读目录名，不解析 project.json：设置页要的是「这个目录里有几本书」，
 * 解析几十个 JSON 会把一次设置读取变成一次全库扫描。
 * 损坏的项目也计入（用户需要知道那里有东西，哪怕坏了）。
 */
async function countProjects(workspace) {
  const root = path.join(workspace, 'projects');
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* 空闲端口                                                                    */
/* -------------------------------------------------------------------------- */

/** 让内核挑一个空闲端口；拿到就立刻关掉，后续由 panel 自己 bind。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* panel 子进程                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 一个 panel 进程对应一个工作区。
 *
 * 为什么要长驻：每章生成要读索引（`index.json` 21 MB）、复用 LLMSession。
 * 每次请求都冷启动一个 Python，一章要几十秒，且索引要反复解析。
 */
class PanelProcess {
  constructor(workspace) {
    this.workspace = workspace;
    this.port = null;
    this.child = null;
    this.starting = null;
    this.lastError = '';
    this.version = null;
    this.python = null;
    /** 引擎当前用的模型（来自 DSH）；null 表示没选或没写成功。 */
    this.llmModel = null;
    /** 上一次真正下发给引擎的模型配置；用于和引擎当前配置比对（token 会随桥重启变）。 */
    this.llmApplied = null;
    /** 上一次进程退出时的现场（退出码/信号/最近 stderr），用于诊断。 */
    this.lastExit = null;
    /**
     * 引擎安装状态（`lib/runtime.js` 的返回值）。
     *
     * `null` 表示这次会话还没走到安装那一步。有值且 `state === 'failed'` 时，
     * /status 要把它带出去 —— 用户看到「装不上」必须同时看到为什么和下一步，
     * 否则只能来问人。
     */
    this.install = null;
    /**
     * 引擎的访问令牌。
     *
     * 引擎的 HTTP 服务原本谁都能打：端口写在 `engine.log` 和 `last-exit.json`
     * 里，本机任意进程读到端口就能读书稿正文、读任意本地文件、删项目。
     * 现在每次拉起引擎都生成一个新令牌随 `--token` 传进去，之后所有请求都必须
     * 带 `X-Ndecon-Token`。
     *
     * 为什么是每个进程一个而不是落盘一个：令牌只活在内存里，进程重启就换新的，
     * 旧的自动失效 —— 没有「令牌文件被读走」这条攻击路径，也不用做轮换。
     */
    this.panelToken = crypto.randomBytes(24).toString('hex');
  }

  get origin() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  /**
   * 拼一份带访问令牌的请求头。
   *
   * 引擎开了访问校验后，除了 `/api/health` 和静态资源，所有接口都必须带
   * `X-Ndecon-Token`；漏一处就是 401，而 401 在界面上看起来像「引擎没配好」。
   * 所以统一从这里出，别再手写 headers 字面量。
   */
  _panelHeaders(extra) {
    return { ...(extra || {}), 'x-ndecon-token': this.panelToken };
  }

  /** 幂等地把进程拉起来；并发调用共享同一个 starting Promise。 */
  async ensureStarted() {
    if (this.port && this.child && !this.child.killed) return this.origin;
    if (this.starting) return this.starting;
    this.starting = this._boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * 启动前先确认工作区是**可用的目录**。
   *
   * 为什么要单独查：spawn 的 cwd 指向不存在路径或文件时，报错码也是 ENOENT，
   * 与「python 不存在」撞车（实测见 _scratch/failure-injection.mjs）。不先查，
   * 用户填错工作区会看到「请重装 Python」。
   */
  async _validateWorkspace() {
    let stat;
    try {
      stat = await fs.stat(this.workspace);
    } catch {
      throw new StudioError(
        'workspace-missing',
        `工作区不存在：${this.workspace}。请到设置里改成已存在的目录，或留空用默认的 .ndecon-workspace。`,
        400,
      );
    }
    if (!stat.isDirectory()) {
      throw new StudioError(
        'workspace-not-dir',
        `工作区不是目录：${this.workspace}。设置里的 workspace 必须是目录路径，不能是文件。`,
        400,
      );
    }
  }

  async _boot() {
    await this._validateWorkspace();
    if (!this.lastExit) {
      // 宿主重启后内存是空的，但磁盘上还留着上一次退出的现场。
      // 不读回来的话，用户看到「引擎未启动」却永远不知道为什么。
      this.lastExit = await readJson(lastExitFile(), null);
    }
    if (!this.python) {
      // 探测解释器时**不能**用工作区当 cwd。
      //
      // 实测（_scratch/failure-injection.mjs）：cwd 指向不存在的目录或一个文件时，
      // spawn 报的错误码同样是 ENOENT，与「python.exe 不存在」无法区分。结果就是
      // 工作区填错时用户看到「找不到 Python，请重装」—— 把他引到完全错误的方向。
      // 所以这里让探测跑在插件自己的 cwd 上；ndecon 靠 editable 安装的 .pth 导入，
      // 与 cwd 无关。
      const settings = await readJson(settingsFile(), {});
      const explicit = typeof settings.python === 'string' ? settings.python.trim() : '';
      this.python = await resolvePython(explicit ? { explicit } : {});
      if (!this.python) {
        throw new StudioError(
          'python-missing',
          '找不到可用的 Python 解释器（试过 python / py -3 / python3）。' +
            '请先装 Python 3.10 或更高版本，装好后点「重启引擎」；' +
            '装在非常规位置的话，在设置里填解释器的绝对路径。',
          503,
        );
      }
    }
    if (!this.version) {
      this.version = await detectNdeconVersion(this.python.argv, this.workspace);
    }
    if (!this.version) {
      // 引擎没装 → 后台装，但**不在这里等**。
      //
      // 为什么不在请求里等：装一次从零要 20–60 秒，慢网络几分钟。而这条 _boot
      // 是被 /_restart 或者一个透传请求同步触发的，等下去就会撞 PROXY_TIMEOUT_MS
      // （300s）—— 那正是「活干完了但用户看到失败」的老坑（连写 10 章 373s 撞
      // 过一次）。所以这里只把安装任务挂到后台，立刻抛出可渲染的状态，让用户
      // 在面板上看到「正在装写作引擎，第 N 步」，装完自己接着起。
      this._startInstall();
      throw new StudioError(
        'engine-installing',
        '写作引擎（novel-deconstruct）还没装，正在后台安装，面板会自动接上。' +
          '装完不用再点「重启引擎」。',
        503,
      );
    }

    let lastError = '';
    for (let attempt = 0; attempt < PANEL_PORT_ATTEMPTS; attempt += 1) {
      const port = await findFreePort();
      try {
        await this._spawnOn(port);
        this.port = port;
        this.lastError = '';
        // 引擎起来后立刻把「模型从哪来」告诉它：不然用户在面板里点 AI 生成，
        // 会撞上 ndecon 自己的「尚未选择模型供应商」，看起来像插件没配好。
        await this._syncLlmSettings();
        return this.origin;
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        this._kill();
      }
    }
    this.lastError = lastError;
    throw new StudioError('panel-boot-failed', `nd 引擎启动失败：${lastError}`, 503);
  }

  /**
   * 后台装引擎；装完自动把进程拉起来。
   *
   * 三条必须守住的事：
   *
   * 1. **同一时刻只能有一个安装任务**。`ensureStarted` 会被多个请求并发调用，
   *    不挡的话会同时跑好几个 pip —— pip 自己的锁会报 `Could not install
   *    packages due to an OSError`，看起来像磁盘坏了。
   * 2. **装完必须真去起进程**。只把 `version` 填上，用户还是看到一个没起来的
   *    面板，得再点一次「重启引擎」—— 那就等于没做自动安装。
   * 3. **装失败不许自动重试**。失败原因（代理挂了、没权限、离线）用户不改就
   *    不会变，循环重试只会一直占着 pip 和网络。错误留在 `this.install` 里，
   *    等用户点「重试」。
   */
  _startInstall() {
    if (this.installing) return this.installing;
    this.install = {
      state: 'installing', attempt: 1, version: null, reason: null, hint: '正在准备安装…', at: new Date().toISOString(),
    };
    this.installing = (async () => {
      try {
        const result = await ensureEngine({
          pythonArgv: this.python.argv,
          detect: async (argv) => detectNdeconVersion(argv, this.workspace),
          onProgress: (state) => {
            this.install = state;
          },
        });
        this.install = result;
        if (result.state !== 'installed') {
          this.lastError = scrubPaths(result.hint || '装不上写作引擎');
          await appendEngineLog('engine.log', `\n[${new Date().toISOString()}] install failed: ${result.reason}\n`);
          return;
        }
        this.version = result.version;
        this.lastError = '';
        await appendEngineLog('engine.log', `\n[${new Date().toISOString()}] install ok: ${result.version}\n`);
        // 装好了就接着起。失败也不抛出去：这是后台任务，没有调用方在等，
        // 抛出去只会变成一次未捕获异常，而真正的原因已经写进 lastError 了。
        await this.ensureStarted().catch((error) => {
          this.lastError = String((error && error.message) || error);
        });
      } catch (error) {
        this.install = { ...this.install, state: 'failed', reason: 'unknown', hint: '安装过程出错。' };
        this.lastError = scrubPaths(String((error && error.message) || error));
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  async _spawnOn(port) {
    const argv = [
      ...this.python.argv, '-m', 'ndecon.cli', 'panel',
      '--workspace', this.workspace,
      '--host', '127.0.0.1',
      '--port', String(port),
      // 令牌走 argv 而不是环境变量：环境变量在 Windows 上会被子进程再传给
      // 它的子孙（包括未来可能被 spawn 的模型 CLI），argv 只到这一层。
      // 反过来 argv 会被其他本机进程从进程表里看到 —— 但能读进程表的进程
      // 本来就能读 engine.log 里的端口，威胁模型上不新增暴露面。
      '--token', this.panelToken,
    ];
    const child = spawn(argv[0], argv.slice(1), {
      cwd: this.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
      appendEngineLog('engine.log', text);
    });
    // stderr 也要挂 error 监听，和上面 stdout 对齐。
    //
    // 不挂的后果不是「少一条日志」而是**宿主整个进程退出**：子进程被强杀时
    // 管道对端消失，readable 流会 emit('error', EPIPE)，没有监听器就是
    // uncaughtException；宿主装了 installFailLoud，它把 uncaughtException
    // 直接翻译成 process.exit(1)（实测 _scratch/stderr-error-unhandled.mjs
    // 复现）。真实强杀 6 轮未复现，但这是唯一一条能拖宿主下水的路径。
    child.stderr.on('error', () => { /* 子进程退出时读到 EPIPE，忽略 */ });
    // stdout 必须有人读，否则会死锁。
    //
    // 实测（_scratch/stdout-deadlock.mjs）：子进程往无人读取的 pipe 里写超过
    // 管道缓冲（Windows 约 64KB）后，write 阻塞、进程永久卡住。症状是「引擎
    // 无故停摆、章节生成永远转圈」，且不产生任何错误日志 —— 极难排查。
    // 现在引擎本身几乎不往 stdout 写（`log_message` 已静默），但以后加一行
    // 进度打印就会踩中，所以这里持续消费并把最近内容留作诊断。
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (stdout.length > 8192) stdout = stdout.slice(-8192);
      appendEngineLog('engine.log', text);
    });
    child.stdout.on('error', () => { /* 子进程退出时读到 EPIPE，忽略 */ });
    child.on('error', (error) => {
      // spawn 本身失败（解释器被删、cwd 失效）时不会走到 exit，必须在这里
      // 清掉引用，否则 _waitHealthy 会白等满 12s 才报「超时」，把真因埋掉。
      this.lastError = String(error && error.message);
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
    });
    // 进程自己死了（崩溃/被系统杀掉）就把端口状态清掉，下一次调用会重新拉起。
    //
    // 同时把「怎么死的」记下来。没有这条记录时，用户看到的是
    // 「无法连接引擎（http://127.0.0.1:62238）：fetch failed」—— 一个既不含
    // 退出码也不含 stderr 的错误，排查只能靠猜。引擎是 python 子进程，它可能
    // 被宿主回收、被系统杀掉、或自己抛异常退出，这三种处理方式完全不同。
    child.on('exit', (code, signal) => {
      // 记现场**不受** `this.child === child` 限制。
      //
      // 原实现只在「自己还是当前子进程」时记录，而 _kill() 会先把 this.child
      // 清空再杀进程 —— 结果主动停止时 exit 处理器直接 return，磁盘上永远没有
      // last-exit.json（实测：logcheck 脚本里 last-exit 恒为 null）。
      // 主动停止与意外退出要能区分，所以记一个 intentional 标记。
      const intentional = !!child.__nsIntentionalStop;
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
      this.lastExit = {
        at: new Date().toISOString(),
        port,
        code,
        signal: signal || null,
        intentional,
        stderr: (stderr || '').slice(-400),
        stdout: (stdout || '').slice(-200),
      };
      // 落盘：宿主重启后内存里的 lastExit 就没了，而这正是排查
      // 「无法连接引擎」唯一的证据（退出码 + stderr）。
      writeJson(lastExitFile(), this.lastExit).catch(() => {});
      appendEngineLog(
        'engine.log',
        `\n[${new Date().toISOString()}] engine exited port=${port} code=${code} signal=${signal || '-'} intentional=${intentional}\n`,
      );
      console.warn(
        `[dsh-novel-agent] 引擎退出：port=${port} code=${code} signal=${signal || '-'} intentional=${intentional}`,
        this.lastExit.stderr || '(无 stderr)',
      );
    });

    await this._waitHealthy(port, () => stderr);
  }

  async _waitHealthy(port, stderrOf) {
    const deadline = Date.now() + PANEL_BOOT_TIMEOUT_MS;
    let lastError = '';
    while (Date.now() < deadline) {
      if (this.child === null) throw new Error('panel 进程已退出：' + (stderrOf() || '无输出'));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) return;
        lastError = `health 返回 ${response.status}`;
      } catch (error) {
        lastError = String(error && error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`等待 /api/health 超时（${PANEL_BOOT_TIMEOUT_MS}ms，最后错误：${lastError}）`);
  }

  /**
   * 把「模型从哪来」写进引擎的 LLM 设置。
   *
   * ndecon 的所有 AI 调用都走「HTTP 打 OpenAI 兼容端点」，它不知道 DSH 的存在。
   * 所以这里在插件进程里起一个桥（`lib/bridge.js`），再把引擎的 `custom`
   * 供应商指向那个桥——**引擎一行都不用改**，用户在右栏看到的模型就是 DSH 里
   * 配好的那个。
   *
   * 没选模型时不写：让引擎如实报「尚未选择模型供应商」，而不是让用户以为
   * 配好了、点生成却拿到 503。
   */
  async _applyLlmSettings(port) {
    if (!llmBridge || !hostCtx) return;
    let route;
    try {
      route = await routeResolver();
    } catch {
      route = undefined;
    }
    if (!route) {
      this.llmModel = null;
      return;
    }
    let origin;
    try {
      origin = await llmBridge.start();
    } catch (error) {
      this.lastError = `模型桥启动失败：${String(error && error.message)}`;
      return;
    }
    const body = {
      provider: 'custom',
      base_url: `${origin}/v1`,
      api_key: llmBridge.token,
      model: route.model,
    };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
        method: 'PUT',
        headers: this._panelHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text();
        this.lastError = `引擎拒绝了模型设置：${text.slice(0, 200)}`;
        this.llmModel = null;
        return;
      }
      this.llmModel = { provider: route.provider, model: route.model, source: route.source };
      this.llmApplied = { baseUrl: body.base_url, model: body.model, token: body.api_key };
    } catch (error) {
      this.lastError = `写入模型设置失败：${String(error && error.message)}`;
      this.llmModel = null;
    }
  }

  /**
   * 核对引擎的模型配置，不一致就重新下发。
   *
   * 为什么必须每次拉起后核对：桥的 token 是**插件进程内**随机生成的，
   * 引擎的配置只存在**它自己进程内存**里。任何一方重启，两边就对不上——
   * 引擎还拿着旧 token，插件这边已经是新 token，于是每次请求都返回
   * `HTTP 401 token 不匹配`。用户看到的是「换了个模型就报错」，其实换模型
   * 本身没问题，是重启把 token 弄丢了（实测 2026-11-04）。
   *
   * 只读一次 GET /api/llm/settings 做比对，代价是一次本地回环请求；
   * 对不上才 PUT。不做这个的话，用户只能靠「重启宿主」碰运气。
   */
  async _syncLlmSettings() {
    if (!this.port) return;
    let want;
    try {
      want = await routeResolver();
    } catch {
      want = undefined;
    }
    if (!want) {
      this.llmModel = null;
      return;
    }
    let origin;
    try {
      origin = await llmBridge.start();
    } catch {
      return;
    }
    const expected = {
      provider: 'custom',
      base_url: `${origin}/v1`,
      api_key: llmBridge.token,
      model: want.model,
    };
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/api/llm/settings`, {
        method: 'GET',
        headers: this._panelHeaders(),
      });
      if (response.ok) {
        const current = await response.json();
        // 三个字段任一对不上就重发：base_url 决定请求打到哪，api_key 决定能不能进，
        // model 决定生成用哪个。少比一个就会出现「看起来配好了、生成时 401」。
        // 比对 key 指纹而不是 has_key：has_key 只能说明「有 key」，说明不了
        // 「还是我刚下发的那个」。桥每次重启都会换 token，只比 has_key 的话
        // 两边都显示配好了，用户要到点生成时才吃 401（实测 2026-11-04）。
        if (
          current
          && current.base_url === expected.base_url
          && current.model === expected.model
          && current.key_fingerprint === fingerprintOf(expected.api_key)
        ) {
          this.llmModel = { provider: want.provider, model: want.model, source: want.source };
          return;
        }
      }
    } catch {
      // 读不到就当作不一致，走下面的重发
    }
    await this._applyLlmSettings(this.port);
  }

  _kill() {
    const child = this.child;
    this.child = null;
    this.port = null;
    if (!child) return;
    // 标成「主动停止」：exit 处理器据此区分「我让它停的」与「它自己死的」。
    // 不标的话，用户点「重启引擎」也会被记成一次崩溃，把真问题埋掉。
    child.__nsIntentionalStop = true;
    try { child.kill(); } catch { /* 已退出 */ }
  }

  stop() {
    this._kill();
  }

  async status() {
    let route = null;
    try {
      route = await routeResolver();
    } catch {
      route = null;
    }
    // 只报界面真正要用的字段。
    //
    // 原实现把 python 解释器路径、引擎 origin、模型桥地址、日志绝对路径一起返回，
    // 这些都会被原样写进浏览器：`C:\Users\<用户名>\AppData\...` 里带着本机用户名，
    // 用户把截图发出去就等于把目录结构发出去了。前端对这几个字段零引用（grep 过），
    // 所以直接不返回，而不是返回再抹。
    //
    // `workspace` 例外：它就是用户在设置页里自己填的那个目录，前后端都要拿它来显示
    // 与校验，抹成 `<路径>` 反而成了 bug。它和 `_settings.workspace` 是同一个值。
    return {
      workspace: this.workspace,
      running: !!this.port,
      port: this.port,
      ndeconVersion: this.version,
      lastError: this.lastError ? scrubPaths(this.lastError) : null,
      /** 模型来自 DSH；`hasModel=false` 时界面要显式提示，不能假装能用。 */
      hasModel: !!route,
      model: route ? { provider: route.provider, model: route.model, source: route.source } : null,
      /** 上一次引擎退出：只留退出码与最后一行业务原因，traceback 会带绝对路径。 */
      lastExit: this.lastExit ? lastExitView(this.lastExit) : null,
      /** 引擎日志的相对落点；绝对路径留在本地 last-exit.json 里，不出现在界面上。 */
      logFile: 'logs/engine.log',
      /**
       * 引擎安装进度。
       *
       * 装引擎要几十秒到几分钟，期间面板只能看到「引擎未启动」。把状态带出去，
       * 前端才能说「正在装写作引擎，第 2 步」而不是让用户以为插件挂了。
       * `output` 在这里过一道 scrubPaths + 限长：pip 的报错里全是绝对路径。
       */
      engineInstall: this.install
        ? {
          state: this.install.state,
          attempt: this.install.attempt,
          version: this.install.version || null,
          reason: this.install.reason || null,
          hint: this.install.hint ? scrubPaths(this.install.hint) : null,
          at: this.install.at || null,
        }
        : null,
    };
  }
}

/** 上一次退出现场的对外视图：抹路径、只留最后一行（诊断要的是原因，不是整个 traceback）。 */
function lastExitView(exit) {
  const stderr = lastLine(scrubPaths(exit.stderr), 300);
  const stdout = lastLine(scrubPaths(exit.stdout), 200);
  return {
    at: exit.at || null,
    code: exit.code == null ? null : exit.code,
    signal: exit.signal || null,
    intentional: !!exit.intentional,
    stderr,
    stdout,
  };
}

/** 每个工作区一个进程，全局复用。 */
const panels = new Map();

/**
 * apply() 时记下来的宿主 ctx 与模型桥。
 *
 * PanelProcess 的方法要在「没有闭包」的地方拿到 ctx（它可能在 apply 之后
 * 才被第一次用到），所以只能放模块级。宿主是单实例进程，这样是安全的。
 */
let hostCtx = null;
let llmBridge = null;
/** 由 apply 装进来的路由解析器（面板起引擎前要拿它算当前模型）。 */
let routeResolver = async () => undefined;

function panelFor(workspace) {
  const existing = panels.get(workspace);
  if (existing) return existing;
  const created = new PanelProcess(workspace);
  panels.set(workspace, created);
  return created;
}

/* -------------------------------------------------------------------------- */
/* DSH 模型                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 取可选服务。
 *
 * cordis 的 fiber ctx 对**未注入**的属性访问会直接抛错，所以每个属性都要单独
 * try。旧宿主可能根本没有 llm / agentDefaultModel，那时返回 undefined，
 * 由调用方如实报「没有模型服务」，绝不静默假装有。
 */
function optionalService(ctx, key) {
  if (!ctx) return undefined;
  try {
    const direct = ctx[key];
    if (direct) return direct;
  } catch { /* 未注入 */ }
  if (typeof ctx.get !== 'function') return undefined;
  try {
    const value = ctx.get(key, false);
    if (value) return value;
  } catch {
    try {
      const value = ctx.get(key);
      if (value) return value;
    } catch { /* 不存在 */ }
  }
  return undefined;
}

/** 读 DSH 当前默认模型选择；没配返回 undefined。 */
function currentModelSelection(ctx) {
  const service = optionalService(ctx, 'agentDefaultModel');
  if (!service || typeof service.currentSelection !== 'function') return undefined;
  try {
    const selection = service.currentSelection();
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
      && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model };
    }
  } catch { /* 读不到就当没配 */ }
  return undefined;
}

/**
 * 决定用哪个模型：插件自己存的选择优先，否则跟随 DSH 默认模型。
 *
 * 为什么要能单独存：`agentDefaultModel` 是**全会话共享**的全局默认。写小说
 * 一章要几千字、成本比聊天高一个量级，想单独换便宜模型时不该动全局设置。
 */
async function resolveModelRoute(ctx) {
  const settings = await readJson(settingsFile(), {});
  const saved = settings.model && typeof settings.model === 'object' ? settings.model : {};
  const provider = typeof saved.provider === 'string' ? saved.provider.trim() : '';
  const model = typeof saved.model === 'string' ? saved.model.trim() : '';
  if (provider && model) return { provider, model, source: 'saved' };
  const fallback = currentModelSelection(ctx);
  return fallback ? { ...fallback, source: 'default' } : undefined;
}

/**
 * 列出 DSH 里可选的模型，供右栏「模型」页渲染。
 *
 * provider 列不出来（宿主没这个服务或旧版本）时返回空数组，界面就只显示
 * 「跟随 DSH 默认模型」——**绝不因为列不出来就假装没模型可选**。
 */
async function listModelOptions(ctx) {
  const llm = optionalService(ctx, 'llm');
  const providers = [];
  const seen = new Set();
  const add = (id, name) => {
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) return;
    seen.add(id);
    providers.push({ id, name: name && String(name).trim() ? String(name) : id, models: [] });
  };
  if (llm && typeof llm.listProviders === 'function') {
    try {
      for (const info of (await llm.listProviders()) || []) {
        if (info && typeof info.id === 'string') add(info.id, info.name);
      }
    } catch { /* 列不出来不影响下面的声明式 provider */ }
  }
  // 已声明但还没拿到模型的 provider 也要列：DeepSeek 的两个路由都属于这类，
  // 它们能不能列出模型取决于登录/key，不列出来用户根本看不到这个选项。
  if (llm && typeof llm.listConfigurableProviders === 'function') {
    try {
      for (const entry of (await llm.listConfigurableProviders()) || []) {
        if (entry && typeof entry.provider === 'string') {
          add(entry.provider, entry.displayName);
          const target = providers.find((item) => item.id === entry.provider);
          if (target && entry.error) target.error = String(entry.error);
        }
      }
    } catch { /* 同上 */ }
  }
  for (const provider of providers) {
    if (!llm || typeof llm.listModels !== 'function') continue;
    try {
      const models = (await llm.listModels(provider.id)) || [];
      provider.models = models
        .filter((item) => item && typeof item.id === 'string' && item.id.trim())
        .map((item) => ({ id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id }));
    } catch { /* 单个 provider 列不出来不影响别人 */ }
  }
  return providers;
}

/* -------------------------------------------------------------------------- */
/* 透传                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 校验透传路径。
 *
 * 插件是唯一能把请求打到 panel 的门，所以这里必须自己把住：`tail` 里出现
 * `..`、反斜杠、盘符或控制字符，一律拒。不然一个
 * `/novel-studio/api/../../../x` 就能让 Python 侧去读它不该读的路径
 * （ndecon 自己有 `_assert_safe`，但两道闸总比一道强）。
 */
function assertSafeTail(tail) {
  if (!tail) throw new StudioError('bad-request', '路径为空');
  if (tail.includes('..') || tail.includes('\\') || tail.includes(':')) {
    throw new StudioError('bad-request', `非法路径：${tail}`);
  }
  if (!SAFE_TAIL.test(tail)) {
    throw new StudioError('bad-request', `路径含非法字符：${tail}`);
  }
  return tail;
}

/**
 * 把请求转发给 panel，响应原样回传。
 *
 * 不解析、不改写响应体：面板渲染的是 ndecon 自己的字段，TS 侧多解释一层就多
 * 一处会跟 Python 走偏的地方。
 */
/** key 的短指纹，与 Python 侧 _key_fingerprint 同一算法（sha256 前 12 位）。 */
function fingerprintOf(key) {
  if (!key) return '';
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 12);
}

async function proxyToPanel(req, res, workspace, tail, search) {
  const safeTail = assertSafeTail(tail);
  const panel = panelFor(workspace);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    // 逐跳头与 host 必须重写，其余（content-type 等）原样带过去。
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(key)) continue;
    // 浏览器是无权指定这两个头的，必须由插件覆写：
    // - x-ndecon-token 是插件与引擎之间的凭据，前端发什么都不算数；
    // - cookie 更不该转发 —— 它属于 DSH 宿主的会话，引擎完全用不到，
    //   带过去只会把宿主凭据平白暴露给一个本地 HTTP 服务。
    if (key === 'x-ndecon-token' || key === 'cookie') continue;
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(',') : value;
  }
  headers['x-ndecon-token'] = panel.panelToken;

  const method = req.method || 'GET';
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readRawBody(req, MAX_BODY_BYTES);
  }

  // 连不上就重拉一次再试。
  //
  // 引擎是长驻 python 子进程，会被宿主回收、被系统杀掉、或因工作区被移动而
  // 起不来。以前这里直接把「无法连接引擎（http://127.0.0.1:62238）」抛给用户，
  // 而那个端口号早已无效 —— 用户能做的只有重启宿主，可问题往往只出在子进程
  // 上。现在把「重拉 + 重试」做在插件里：第一次失败时清掉进程，重新 ensureStarted
  // 并重发同一次请求（body 已读进 Buffer，可以原样重发）。
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let origin;
    try {
      origin = await panel.ensureStarted();
    } catch (error) {
      throw error instanceof StudioError
        ? error
        : new StudioError('panel-unavailable', String(error && error.message), 503);
    }

    // 超时必须有：Python 侧一次生成卡住（真模型 30–120s），右栏的请求就会挂着；
    // 没有超时的话，用户在界面上看到的是「永远在转圈」，连取消都点不了。
    //
    // 定时器要一直活到**读完响应体**为止：signal 同时管住 header 与 body 流，
    // 在读 body 之前就 clearTimeout，等于给后半段摘掉了超时保护（引擎卡在写
    // 一半的响应上时，前端会无限转圈）。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(`${origin}/api/${safeTail}${search || ''}`, {
        method, headers, body, redirect: 'manual', signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error && error.name === 'AbortError') {
        // 超时**不杀进程**：引擎可能正写到一半（章事务是「先写 run 记录 → 正文 →
        // 项目 JSON」），杀掉它会把一次本可完成的提交变成半截状态。只报告，让用户
        // 自己决定要不要点「重启引擎」；未提交的 run 记录会留在 runs/ 下，下次能看见。
        throw new StudioError(
          'panel-timeout',
          `引擎 ${PROXY_TIMEOUT_MS / 1000}s 内没有响应。它可能仍在后台生成（真模型一章可达 180s），可稍后重试或重启引擎。`,
          504,
        );
      }
      // 连不上说明进程已经没了（或从没起来）。清掉缓存，下一轮循环会重拉。
      lastError = { origin, error };
      panel.stop();
      continue;
    }

    // 先把响应体整个读完再写头部。
    //
    // 原实现在「头部已写、读 body 时引擎崩了」这一步只能 destroy 连接 —— 因为
    // 状态码已经发出去了，没法改成 502 让前端重试。改成先读完再写，同一个
    // 「读到一半断掉」就还能走重拉逻辑，用户看到的也不是一个被掐断的响应。
    let buffer;
    let contentType;
    try {
      contentType = upstream.headers.get('content-type');
      buffer = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      clearTimeout(timer);
      if (error && error.name === 'AbortError') {
        throw new StudioError(
          'panel-timeout',
          `引擎 ${PROXY_TIMEOUT_MS / 1000}s 内没有把响应读完（可能在生成中被掐断）。可稍后重试。`,
          504,
        );
      }
      lastError = { origin, error };
      panel.stop();
      continue;
    }
    clearTimeout(timer);
    if (contentType) res.setHeader('content-type', contentType);
    // 下载类响应（导出的 epub/docx）的文件名只存在于这个头里。engine 用 RFC 5987
    // 的 filename* 带中文书名，丢了它前端只能自己猜一个名字，猜错了用户拿到的
    // 是一堆没有书名的 export.epub。二进制照原样透传，这里只多带一个头。
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) res.setHeader('content-disposition', disposition);
    res.statusCode = upstream.status;
    res.end(buffer);
    return;
  }

  // 两轮都连不上：把退出现场带上，否则用户只看到一个早已失效的端口号。
  //
  // stderr 只留最后一行并抹掉绝对路径：traceback 里第一行是文件路径、中间是
  // site-packages 路径，真正有用的只有最后那句异常。整段贴给用户 = 把他自己的
  // 目录结构贴进浏览器。
  const exit = panel.lastExit;
  const reason = lastError && lastError.error ? String(lastError.error.message || lastError.error) : '';
  const exitTail = exit ? lastLine(scrubPaths(exit.stderr), 300) : '';
  const hint = exit
    ? `上一次引擎退出：code=${exit.code} signal=${exit.signal || '-'}` + (exitTail ? `，原因：${exitTail}` : '')
    : `引擎没能起来${reason ? `（${reason}）` : ''}`;
  throw new StudioError(
    'panel-unreachable',
    `无法连接引擎（已自动重拉一次仍失败）。${hint}`,
    502,
  );
}

/**
 * 读原始请求体；超限报 413。
 *
 * 超限时**不能立刻抛**：客户端还在往同一个 socket 写剩余数据，服务端抢先结束
 * 响应会让这次请求本身变成 `ECONNRESET`（用户看到的是「413 没收到，直接报错」），
 * 而且这条连接会被标脏、后续请求复用就全挂（实测见 test/smoke.mjs 的 9MiB 用例）。
 * 所以超限后继续把剩余数据读完并丢弃，再抛错 —— 此时客户端已经写完，能正常读到
 * 413。为防止有人真的无限流式发送，另设一个**绝对**上限（不是 limit 的倍数：
 * 各端点 limit 不同，_settings 只有 64KB，乘 8 才 512KB，9MiB 的请求会撞上它
 * 而被 reset），超过才断开。
 */
const ABSOLUTE_MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readRawBody(req, limit) {
  const parts = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) over = true;
    if (over) {
      if (size > ABSOLUTE_MAX_BODY_BYTES) {
        // 绝对上限也破了：这时不能等它写完，直接断开连接。
        req.destroy();
        throw new StudioError('too-large', `请求体超过 ${Math.round(limit / 1048576)} MiB（已断开连接）`, 413);
      }
      continue; // 丢弃，但继续消费，保证客户端能把数据写完
    }
    parts.push(chunk);
  }
  if (over) {
    throw new StudioError('too-large', `请求体超过 ${Math.round(limit / 1048576)} MiB`, 413);
  }
  return parts.length ? Buffer.concat(parts) : undefined;
}

/* -------------------------------------------------------------------------- */
/* 栅栏                                                                        */
/* -------------------------------------------------------------------------- */

/** 自写栅栏：跨站请求直接拒。 */
function fence(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return 'cross-site requests are rejected';
  return undefined;
}

/** DSH 官方信任栅栏：回环 / trusted-host / 浏览器会话认证。 */
function trustFence(req, ctx) {
  const connection = ctx.connection;
  if (!connection || typeof connection.requestRejection !== 'function') return undefined;
  const rejection = connection.requestRejection(req);
  return rejection ? 'host trust fence rejected (' + rejection + ')' : undefined;
}

/* -------------------------------------------------------------------------- */
/* 路由                                                                        */
/* -------------------------------------------------------------------------- */

export function apply(ctx) {
  /** 当前会话的工作区（宿主每次请求都可能带不同的 sessionId，这里只取默认）。 */
  let defaultWorkspace = null;

  // 改名后的首次加载：把旧版 settings.json 搬过来。必须最早做——
  // 下面所有 resolveWorkspace() 都按新目录读设置，搬晚了第一次列项目就是空书架。
  // 不 await：搬文件是毫秒级，但让 apply 变 async 会推迟整个路由注册。
  void migrateLegacyData();

  // 模型桥：把 DSH 的 llm.stream 暴露成一个本地 OpenAI 兼容端点给引擎用。
  hostCtx = ctx;
  /** bridge 的 getRoute 是同步的，所以每次算好的路由要缓存一份在这里。 */
  let currentRouteForBridge = null;
  llmBridge = createLlmBridge({
    getLlm: () => optionalService(ctx, 'llm'),
    getRoute: () => currentRouteForBridge,
    log: (tag, data) => console.warn(`[dsh-novel-agent] ${tag}`, data),
  });
  void resolveModelRoute(ctx).then((route) => { currentRouteForBridge = route || null; }).catch(() => {});
  routeResolver = async () => {
    const route = await refreshRoute();
    return route || undefined;
  };

  async function refreshRoute() {
    try {
      currentRouteForBridge = (await resolveModelRoute(ctx)) || null;
    } catch {
      currentRouteForBridge = null;
    }
    return currentRouteForBridge;
  }

  async function workspaceFor() {
    if (defaultWorkspace) return defaultWorkspace;
    defaultWorkspace = await resolveWorkspace();
    return defaultWorkspace;
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      // 解析路径、解析工作区、读请求体都可能抛——它们必须全都在 try 里。
      // 在 try 之外抛的话 handler 的 Promise 会 reject，res 永远不会 end，
      // 请求一直挂着：用户看到的是「点了没反应」，宿主只留一条未捕获异常。
      let sent = false;
      const send = (status, body) => {
        if (sent) return;
        sent = true;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };

      const denied = fence(req) || trustFence(req, ctx);
      if (denied) {
        send(403, { ok: false, error: { code: 'forbidden', message: denied } });
        return;
      }

      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        let tail;
        try {
          tail = decodeURIComponent(parsed.pathname.slice(API_PREFIX.length).replace(/^\/+/, ''));
        } catch {
          throw new StudioError('bad-request', '路径编码非法');
        }
        const workspace = await workspaceFor();

        // 插件自己的元信息，不走 panel：即使引擎没起来，设置页也要能看见状态。
        if (tail === '_status') {
          const panel = panelFor(workspace);
          send(200, { ok: true, value: await panel.status() });
          return;
        }
        if (tail === '_settings' && req.method === 'GET') {
          const settings = await readJson(settingsFile(), {});
          // 同时报项目数：换工作区最常见的后果是「项目不见了」，
          // 只给路径不给数量，用户无法判断自己改对了没有。
          let projectCount = null;
          try {
            projectCount = await countProjects(workspace);
          } catch { projectCount = null; }
          send(200, {
            ok: true,
            value: {
              workspace,
              workspaceOverride: settings.workspace || null,
              projectCount,
              // 用户填的解释器绝对路径要能读回来，否则设置页没法回填，
              // 用户改过一次就再也看不到自己填了什么。
              python: settings.python || null,
            },
          });
          return;
        }
        if (tail === '_settings' && req.method === 'PUT') {
          // JSON.parse 抛 SyntaxError 是用户输入问题，必须回 400 并说明，不能变成 500。
          // 但 readRawBody 自己抛的 413（超大）要原样往上走，不能被这里吞成 400。
          const rawBody = await readRawBody(req, 65536);
          let payload;
          try {
            payload = JSON.parse(rawBody || '{}');
          } catch {
            throw new StudioError('bad-request', '请求体不是合法 JSON');
          }
          if (!payload || typeof payload !== 'object') {
            throw new StudioError('bad-request', '请求体必须是 JSON 对象');
          }
          const next = { ...(await readJson(settingsFile(), {})) };
          // 字段是可选的：只改解释器时不该被迫连带提交一次工作区
          // （漏传 workspace 就回「workspace 必须是字符串或 null」，
          // 用户会以为自己填的路径有问题）。
          if ('workspace' in payload) {
            const raw = payload.workspace;
            if (raw === null || raw === '') delete next.workspace;
            else if (typeof raw === 'string') next.workspace = raw.trim();
            else throw new StudioError('bad-request', 'workspace 必须是字符串或 null');
          }
          // `python`：装在非常规位置时的解释器绝对路径。
          //
          // 这个字段一直被 _boot 读取，却没有任何地方能写进 settings.json ——
          // 用户看到「填解释器路径」的提示，转头去设置页发现根本没这个输入框。
          if ('python' in payload) {
            const py = payload.python;
            if (py === null || py === '') delete next.python;
            else if (typeof py === 'string') next.python = py.trim();
            else throw new StudioError('bad-request', 'python 必须是字符串或 null');
          }
          await writeJson(settingsFile(), next);
          defaultWorkspace = null;
          resetPythonCache();
          resetInstallCache();
          resetInstallCache();
          // 换工作区后旧 panel 还指着老目录，必须停掉；否则用户改完看到的还是旧书。
          for (const panel of panels.values()) panel.stop();
          panels.clear();
          const resolved = await workspaceFor();
          let projectCount = null;
          try { projectCount = await countProjects(resolved); } catch { projectCount = null; }
          send(200, { ok: true, value: { workspace: resolved, projectCount } });
          return;
        }
        if (tail === '_restart' && req.method === 'POST') {
          // 「重启」就应该是重启，而不是「停掉等你再点一次」。
          //
          // 原实现只 stop()，然后返回 restarted:true —— 界面刷新后显示
          // 「引擎未启动」，用户会以为重启失败了。这里 stop 完立刻重新拉起，
          // 把新端口与状态一起返回；拉不起来也照样返回 200 带错误，
          // 因为「重启失败」本身是业务结果，不是请求失败。
          const panel = panelFor(workspace);
          panel.stop();
          let restarted = false;
          let error = null;
          try {
            await panel.ensureStarted();
            restarted = true;
          } catch (e) {
            error = String((e && e.message) || e);
          }
          send(200, { ok: true, value: { restarted, error, status: await panel.status() } });
          return;
        }
        // 「模型」页：DSH 里有哪些模型、当前用哪个、能不能用。
        if (tail === '_models' && req.method === 'GET') {
          const providers = await listModelOptions(ctx);
          const route = await refreshRoute();
          const settings = await readJson(settingsFile(), {});
          send(200, {
            ok: true,
            value: {
              providers,
              current: route ? { provider: route.provider, model: route.model, source: route.source } : null,
              saved: settings.model && typeof settings.model === 'object' ? settings.model : null,
              bridge: llmBridge ? llmBridge.origin : null,
            },
          });
          return;
        }
        if (tail === '_models' && req.method === 'PUT') {
          const rawBody = await readRawBody(req, 65536);
          let payload;
          try {
            payload = JSON.parse(rawBody || '{}');
          } catch {
            throw new StudioError('bad-request', '请求体不是合法 JSON');
          }
          if (!payload || typeof payload !== 'object') {
            throw new StudioError('bad-request', '请求体必须是 JSON 对象');
          }
          const next = { ...(await readJson(settingsFile(), {})) };
          const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
          const model = typeof payload.model === 'string' ? payload.model.trim() : '';
          if (!provider && !model) delete next.model;
          else if (!provider || !model) {
            throw new StudioError('bad-request', 'provider 与 model 要么都填，要么都空（空 = 跟随 DSH 默认模型）');
          } else next.model = { provider, model };
          await writeJson(settingsFile(), next);
          const route = await refreshRoute();
          // 已经起来的引擎要立刻换模型：不换的话用户以为改了，实际还在用旧的。
          // 用 _syncLlmSettings 而不是 _applyLlmSettings：前者会先比对
          // 引擎当前配置，避免桥重启后 token 已变、引擎还拿着旧 token 而 401。
          for (const panel of panels.values()) {
            if (panel.port) await panel._syncLlmSettings();
          }
          send(200, { ok: true, value: { current: route ? { provider: route.provider, model: route.model, source: route.source } : null } });
          return;
        }
        /**
         * 测一个**指定**模型（不保存、不改引擎配置）。
         *
         * 引擎的 `/api/llm/test` 只能测「已经配好的那个」，而用户真正要问的是
         * 「我下拉框里挑的这个行不行」。没有这条，试错就必须先保存再测，
         * 测一次改一次配置——成本高到没人愿意试。
         *
         * 走桥直连宿主 `llm.stream`，不经过引擎：引擎那条路会顺带把
         * 它的 JSON 解析、超时、闸门都拉进来，测出来的就不是模型本身了。
         */
        /**
         * 从 Markdown 设定稿拆出骨架与设定库（只产出草稿，不写盘）。
         *
         * 走 `llmBridge.complete()` 直连宿主 llm：这是宿主进程内部的调用，
         * 没必要把自己起的桥当第三方服务去请求（那条路还要处理 token、端口、
         * 超时，全是自找的）。不经过引擎，因为引擎的 `generate` 只认
         * 「书名 + 一句话前提 + 题材」，用户手里那篇设定根本没有进去的通道。
         */
        if (tail === '_import/md' && req.method === 'POST') {
          const rawBody = await readRawBody(req, MAX_BODY_BYTES);
          let payload;
          try {
            payload = JSON.parse(rawBody || '{}');
          } catch {
            throw new StudioError('bad-request', '请求体不是合法 JSON');
          }
          if (!payload || typeof payload !== 'object') {
            throw new StudioError('bad-request', '请求体必须是 JSON 对象');
          }
          await refreshRoute();
          try {
            const draft = await importFromMarkdown({
              complete: (body) => llmBridge.complete(body),
              markdown: payload.markdown,
              hints: payload.hints && typeof payload.hints === 'object' ? payload.hints : {},
            });
            send(200, { ok: true, value: draft });
          } catch (error) {
            // 桥的失败本来会被包成 502，这里把「稿子的问题」与「模型的问题」分开：
            // 前者 400 让前端直接改稿子，后者 502 让前端提示重试/换模型。
            const status = Number.isInteger(error && error.status) ? error.status : 502;
            send(status, {
              ok: false,
              error: { code: (error && error.code) || 'import-failed', message: scrubPaths(String((error && error.message) || error)) },
            });
          }
          return;
        }
        if (tail === '_models/probe' && req.method === 'POST') {
          const rawBody = await readRawBody(req, 65536);
          let payload;
          try {
            payload = JSON.parse(rawBody || '{}');
          } catch {
            throw new StudioError('bad-request', '请求体不是合法 JSON');
          }
          if (!payload || typeof payload !== 'object') {
            throw new StudioError('bad-request', '请求体必须是 JSON 对象');
          }
          const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
          const model = typeof payload.model === 'string' ? payload.model.trim() : '';
          if (!provider || !model) {
            throw new StudioError('bad-request', 'provider 与 model 都必须填');
          }
          const result = await probeModel(optionalService(ctx, 'llm'), { provider, model }, {
            log: (tag, data) => console.warn(`[dsh-novel-agent] ${tag}`, data),
          });
          // 「通不通」是业务结果，不是请求失败：一律 200，由 ok 字段表达，
          // 让界面自己决定怎么显示。用 5xx 表达的话，前端 request() 会把它
          // 抛成异常，那段原始失败原因就丢了。
          send(200, { ok: true, value: { ...result, provider, model } });
          return;
        }
        // 其余一律透传
        await proxyToPanel(req, res, workspace, tail, parsed.search);
      } catch (error) {
        const known = error instanceof StudioError;
        if (!known) console.error('[dsh-novel-agent]', error);
        // 请求体没读完就报错（典型是 413）时必须让这条连接不要再被复用。
        //
        // 实测（test/smoke.mjs 的 9MiB 用例）：服务端读完上限就抛 413 并结束响应，
        // 客户端还在往同一个 socket 写剩余几 MB —— 这条连接已经脏了。HTTP/1.1
        // 默认 keep-alive，undici 会把它放回连接池，下一次请求复用时就吃
        // `ECONNRESET`。用户侧看到的是「之后的请求莫名全部失败」，而首个请求
        // 明明是正常的 413。
        if (!req.readableEnded) {
          res.setHeader('connection', 'close');
        }
        send(known ? error.status : 500, {
          ok: false,
          error: { code: known ? error.code : 'internal', message: (error && error.message) || 'internal error' },
        });
      }
    },
  }), 'dsh-novel-agent:api');

  // 工具：宿主没有 tools 服务时右栏照常工作，只是模型不能直接调。
  ctx.inject(['tools'], (toolCtx) => {
    try {
      const dispose = registerNovelTools(toolCtx.tools, {
        workspaceFor,
        proxyCall: async (method, tail, body) => {
          const workspace = await workspaceFor();
          const panel = panelFor(workspace);
          const origin = await panel.ensureStarted();
          const response = await fetch(`${origin}/api/${tail}`, {
            method,
            headers: panel._panelHeaders(body ? { 'content-type': 'application/json' } : undefined),
            body: body ? JSON.stringify(body) : undefined,
          });
          const text = await response.text();
          let value = null;
          try { value = JSON.parse(text); } catch { value = null; }
          if (!response.ok) {
            throw new Error(`ndecon 返回 ${response.status}：${value && value.error ? value.error : text.slice(0, 300)}`);
          }
          return value;
        },
        runCli: async (args) => {
          const workspace = await workspaceFor();
          const python = await resolvePython({ cwd: workspace });
          return runNdecon(python ? python.argv : null, args, { cwd: workspace, timeoutMs: 120000 });
        },
      });
      const owner = typeof toolCtx.effect === 'function' ? toolCtx : ctx;
      if (typeof owner.effect === 'function') {
        owner.effect(() => dispose, 'dsh-novel-agent: novel_* tools');
      }
    } catch (error) {
      console.warn(`[dsh-novel-agent] 工具未注册：${String(error && error.message)}`);
    }
  });

  // 卸载时把所有 panel 子进程带走，不留孤儿。
  ctx.effect(() => () => {
    for (const panel of panels.values()) panel.stop();
    panels.clear();
    if (llmBridge) llmBridge.stop();
    llmBridge = null;
    hostCtx = null;
  }, 'dsh-novel-agent: panels');
}

/**
 * 只给 headless 测试用的一扇门。
 *
 * 宿主读的只有 `inject` / `apply`，多导出这一项不改变运行行为；没有它，
 * `test/hosttest.mjs` 就只能靠起一个真宿主来验证子进程起停。
 */
export const __testing = {
  PanelProcess,
  StudioError,
  findFreePort,
  panelFor,
  panels,
  API_PREFIX,
  assertSafeTail,
  fingerprintOf,
  dataDir,
  legacyDataDir,
  migrateLegacyData,
  /** 停掉所有缓存的面板进程；测试收尾必须调，否则子进程会让 node 不退出。 */
  stopAllPanels() {
    for (const panel of panels.values()) panel.stop();
    panels.clear();
  },
};
