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
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';

import { detectNdeconVersion, resetPythonCache, resolvePython, runNdecon } from './python.js';
import { registerNovelTools } from './tools.js';

export const name = 'dsh-novel-studio';

/**
 * 只声明硬依赖。
 *
 * `tools` 走 ctx.inject 而不是写在这里：宿主没有 tools 服务时，右栏照样要能用，
 * 不能因为注册不了工具就整个半边挂掉。
 */
export const inject = ['webServer', 'connection'];

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

/** 插件自己的数据目录：只存「工作区路径」这类插件级设置，不存业务数据。 */
function dataDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'dsh-novel-studio');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'dsh-novel-studio');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'dsh-novel-studio');
}

const settingsFile = () => path.join(dataDir(), 'settings.json');

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
  }

  get origin() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
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
    if (!this.python) {
      // 探测解释器时**不能**用工作区当 cwd。
      //
      // 实测（_scratch/failure-injection.mjs）：cwd 指向不存在的目录或一个文件时，
      // spawn 报的错误码同样是 ENOENT，与「python.exe 不存在」无法区分。结果就是
      // 工作区填错时用户看到「找不到 Python，请重装」—— 把他引到完全错误的方向。
      // 所以这里让探测跑在插件自己的 cwd 上；ndecon 靠 editable 安装的 .pth 导入，
      // 与 cwd 无关。
      this.python = await resolvePython({});
      if (!this.python) {
        throw new StudioError(
          'python-missing',
          '找不到可用的 Python 解释器（试过 python / py -3 / python3 / D:\\Python\\Python310\\python.exe）。' +
            '请在设置里确认 Python 已装好，且 `python -m ndecon.cli version` 能跑。',
          503,
        );
      }
    }
    if (!this.version) {
      this.version = await detectNdeconVersion(this.python.argv, this.workspace);
      if (!this.version) {
        throw new StudioError(
          'ndecon-missing',
          'Python 能跑，但 `python -m ndecon.cli` 不可用：' +
            'novel-deconstruct 未安装或不在 PYTHONPATH 上。请在 novel-deconstruct 里执行 `pip install -e .`。',
          503,
        );
      }
    }

    let lastError = '';
    for (let attempt = 0; attempt < PANEL_PORT_ATTEMPTS; attempt += 1) {
      const port = await findFreePort();
      try {
        await this._spawnOn(port);
        this.port = port;
        this.lastError = '';
        return this.origin;
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        this._kill();
      }
    }
    this.lastError = lastError;
    throw new StudioError('panel-boot-failed', `nd 引擎启动失败：${lastError}`, 503);
  }

  async _spawnOn(port) {
    const argv = [
      ...this.python.argv, '-m', 'ndecon.cli', 'panel',
      '--workspace', this.workspace,
      '--host', '127.0.0.1',
      '--port', String(port),
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
      stderr += chunk.toString('utf8');
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    // stdout 必须有人读，否则会死锁。
    //
    // 实测（_scratch/stdout-deadlock.mjs）：子进程往无人读取的 pipe 里写超过
    // 管道缓冲（Windows 约 64KB）后，write 阻塞、进程永久卡住。症状是「引擎
    // 无故停摆、章节生成永远转圈」，且不产生任何错误日志 —— 极难排查。
    // 现在引擎本身几乎不往 stdout 写（`log_message` 已静默），但以后加一行
    // 进度打印就会踩中，所以这里持续消费并把最近内容留作诊断。
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8192) stdout = stdout.slice(-8192);
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
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
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

  _kill() {
    const child = this.child;
    this.child = null;
    this.port = null;
    if (!child) return;
    try { child.kill(); } catch { /* 已退出 */ }
  }

  stop() {
    this._kill();
  }

  async status() {
    return {
      workspace: this.workspace,
      running: !!this.port,
      port: this.port,
      origin: this.origin,
      python: this.python ? this.python.argv.join(' ') : null,
      pythonVersion: this.python ? this.python.version : null,
      ndeconVersion: this.version,
      lastError: this.lastError,
    };
  }
}

/** 每个工作区一个进程，全局复用。 */
const panels = new Map();

function panelFor(workspace) {
  const existing = panels.get(workspace);
  if (existing) return existing;
  const created = new PanelProcess(workspace);
  panels.set(workspace, created);
  return created;
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
async function proxyToPanel(req, res, workspace, tail, search) {
  const safeTail = assertSafeTail(tail);
  const panel = panelFor(workspace);
  let origin;
  try {
    origin = await panel.ensureStarted();
  } catch (error) {
    throw error instanceof StudioError
      ? error
      : new StudioError('panel-unavailable', String(error && error.message), 503);
  }

  const url = `${origin}/api/${safeTail}${search || ''}`;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    // 逐跳头与 host 必须重写，其余（content-type 等）原样带过去。
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(key)) continue;
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(',') : value;
  }

  const method = req.method || 'GET';
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readRawBody(req, MAX_BODY_BYTES);
  }

  // 超时必须有：Python 侧一次生成卡住（真模型 30–120s），右栏的请求就会挂着；
  // 没有超时的话，用户在界面上看到的是「永远在转圈」，连取消都点不了。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    if (aborted) {
      // 超时**不杀进程**：引擎可能正写到一半（章事务是「先写 run 记录 → 正文 →
      // 项目 JSON」），杀掉它会把一次本可完成的提交变成半截状态。只报告，让用户
      // 自己决定要不要点「重启引擎」；未提交的 run 记录会留在 runs/ 下，下次能看见。
      throw new StudioError(
        'panel-timeout',
        `引擎 ${PROXY_TIMEOUT_MS / 1000}s 内没有响应。它可能仍在后台生成（真模型一章可达 180s），可稍后重试或重启引擎。`,
        504,
      );
    }
    // 连不上说明进程已经没了（或从没起来），清掉缓存让下次请求重新拉起。
    panel.stop();
    throw new StudioError('panel-unreachable', `无法连接引擎（${origin}）：${String(error && error.message)}`, 502);
  } finally {
    clearTimeout(timer);
  }

  // 读 body 也可能失败（引擎中途崩、连接被掐）。这里必须自己兜住并把响应结束掉，
  // 否则抛出后 handler 的 catch 会再试一次 send，但 res 已经写过 header 就报
  // ERR_HTTP_HEADERS_SENT，反而把宿主日志刷满。
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  res.statusCode = upstream.status;
  let buffer;
  try {
    buffer = Buffer.from(await upstream.arrayBuffer());
  } catch (error) {
    // 头部已写，不能改状态码；直接把连接断掉，让前端 fetch 报错重试。
    res.destroy(error);
    throw new StudioError('panel-unreachable', `引擎响应读取失败：${String(error && error.message)}`, 502);
  }
  res.end(buffer);
}

/** 读原始请求体；超限直接 413，而不是把整本正文读进内存再报错。 */
async function readRawBody(req, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new StudioError('too-large', `请求体超过 ${Math.round(limit / 1048576)} MiB`, 413);
    }
    parts.push(chunk);
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
          send(200, { ok: true, value: { workspace, workspaceOverride: settings.workspace || null } });
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
          const raw = payload.workspace;
          if (raw === null || raw === '') delete next.workspace;
          else if (typeof raw === 'string') next.workspace = raw.trim();
          else throw new StudioError('bad-request', 'workspace 必须是字符串或 null');
          await writeJson(settingsFile(), next);
          defaultWorkspace = null;
          resetPythonCache();
          send(200, { ok: true, value: { workspace: await workspaceFor() } });
          return;
        }
        if (tail === '_restart' && req.method === 'POST') {
          const panel = panelFor(workspace);
          panel.stop();
          send(200, { ok: true, value: { restarted: true } });
          return;
        }
        // 其余一律透传
        await proxyToPanel(req, res, workspace, tail, parsed.search);
      } catch (error) {
        const known = error instanceof StudioError;
        if (!known) console.error('[dsh-novel-studio]', error);
        send(known ? error.status : 500, {
          ok: false,
          error: { code: known ? error.code : 'internal', message: (error && error.message) || 'internal error' },
        });
      }
    },
  }), 'dsh-novel-studio:api');

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
            headers: body ? { 'content-type': 'application/json' } : undefined,
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
        owner.effect(() => dispose, 'dsh-novel-studio: novel_* tools');
      }
    } catch (error) {
      console.warn(`[dsh-novel-studio] 工具未注册：${String(error && error.message)}`);
    }
  });

  // 卸载时把所有 panel 子进程带走，不留孤儿。
  ctx.effect(() => () => {
    for (const panel of panels.values()) panel.stop();
    panels.clear();
  }, 'dsh-novel-studio: panels');
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
  /** 停掉所有缓存的面板进程；测试收尾必须调，否则子进程会让 node 不退出。 */
  stopAllPanels() {
    for (const panel of panels.values()) panel.stop();
    panels.clear();
  },
};
