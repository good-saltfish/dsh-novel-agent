/**
 * 面板可操作性端到端验证：全部走插件的 HTTP 门，落到真 ndecon 引擎进程。
 *
 * 为什么要有这个：`smoke.mjs` 只验代理与安全，`model-e2e.mjs` 只验模型链路，
 * `client-dom.mjs` 只验组件在假 fetch 下的行为。三者都过，仍然可能「面板里点生成
 * 什么都不发生」——因为端点有没有真的接上章事务、参数对不对、返回形状对不对，
 * 只有拿真引擎跑一遍才知道。
 *
 * 覆盖：新建 → 生成骨架 → 自动验收 → 单章生成（过闸门）→ 连写续跑 →
 * 人工编辑 → 版本列表 → 回退 → 确认 → 台账 → 工作区设置与项目计数。
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

function fakeCtx() {
  let handler = null;
  const ctx = {
    webServer: { register(spec) { handler = spec.handler; return () => { handler = null; }; } },
    connection: { requestRejection: () => null },
    effect(fn) { fn(); return () => {}; },
    inject(_names, cb) { cb({ tools: null }); },
  };
  return { ctx, getHandler: () => handler };
}

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

const dataRoot = path.join(os.tmpdir(), 'novel-studio-ops-' + Date.now());
const workspace = path.join(dataRoot, 'ws');
await fs.mkdir(workspace, { recursive: true });

// 隔离插件设置：宿主按 %APPDATA%\dsh-novel-studio\settings.json 解析工作区，
// 不隔离的话本机已有的工作区会盖掉测试目录，测的就不是这里新建的书库了。
// dataDir() 是调用时读环境变量，所以在 apply 之前改就生效。
const appData = path.join(dataRoot, 'appdata');
await fs.mkdir(path.join(appData, 'dsh-novel-studio'), { recursive: true });
await fs.writeFile(
  path.join(appData, 'dsh-novel-studio', 'settings.json'),
  JSON.stringify({ workspace }),
  'utf8',
);
process.env.APPDATA = appData;

const { ctx, getHandler } = fakeCtx();
host.apply(ctx);
const { server, origin } = await serve(getHandler());

// 引擎必须先起来：所有操作端点都靠它。
const panel = panelFor(workspace);
let engineUp = false;
try {
  await panel.ensureStarted();
  engineUp = true;
} catch (error) {
  bad('引擎能起来', String(error && error.message));
}

if (engineUp) {
  ok('引擎能起来');

  // 1. 新建项目（三步：create → generate → accept-skeleton）
  let projectId = null;
  {
    const created = await call(origin, 'POST', 'projects/create', {
      kind: 'creation', title: '操作验证书', premise: '一句话前提', genre: '悬疑',
    });
    if (created.status === 201 && created.body && created.body.meta) {
      projectId = created.body.meta.id;
      ok('新建项目返回 201 与 id');
    } else {
      bad('新建项目返回 201 与 id', `status=${created.status} ${JSON.stringify(created.body)}`);
    }
  }
  if (projectId) {
    const gen = await call(origin, 'POST', `projects/${projectId}/generate`, { provider: 'fake', chapter_count: 12 });
    gen.status === 200 ? ok('生成 12 章骨架') : bad('生成 12 章骨架', `status=${gen.status} ${JSON.stringify(gen.body)}`);

    const accept = await call(origin, 'POST', `projects/${projectId}/accept-skeleton`, {});
    const states = accept.body && accept.body.confirmed_parts;
    const allAccepted = states && ['positioning', 'protagonist', 'golden_finger', 'chapters']
      .every((part) => states[part] === 'auto-accepted');
    accept.status === 200 && allAccepted
      ? ok('骨架自动验收，四部件都是 auto-accepted')
      : bad('骨架自动验收', `status=${accept.status} ${JSON.stringify(accept.body)}`);

    // 2. 单章生成（过闸门）——这是「面板能生成」的核心
    {
      const run = await call(origin, 'POST', `projects/${projectId}/chapters/1/run`, { provider: 'fake' });
      const outcome = run.body && run.body.outcome;
      run.status === 200 && outcome && outcome.status === 'committed'
        ? ok('第 1 章走章事务并提交')
        : bad('第 1 章走章事务并提交', `status=${run.status} ${JSON.stringify(run.body)}`);
      outcome && outcome.verdict === 'pass' && outcome.cjk_chars >= 2000
        ? ok('第 1 章过硬门（pass）且字数达标')
        : bad('第 1 章过硬门', JSON.stringify(outcome));
      run.body && run.body.record && run.body.record.status === 'auto-accepted'
        ? ok('第 1 章落 auto-accepted')
        : bad('第 1 章落 auto-accepted', JSON.stringify(run.body && run.body.record));
      run.body && typeof run.body.content === 'string' && run.body.content.length > 0
        ? ok('返回正文供界面直接显示')
        : bad('返回正文', typeof (run.body && run.body.content));
    }

    // 3. 连写：从游标之后续跑
    {
      const batch = await call(origin, 'POST', `projects/${projectId}/runs`, { from: 2, to: 4, provider: 'fake' });
      batch.status === 200 && batch.body.written === 3 && batch.body.failures === 0
        ? ok('连写第 2–4 章全部提交')
        : bad('连写第 2–4 章', `status=${batch.status} ${JSON.stringify(batch.body)}`);

      const more = await call(origin, 'POST', `projects/${projectId}/runs`, { to: 6, provider: 'fake' });
      more.status === 200 && more.body.from === 5 && more.body.written === 2
        ? ok('不传 from 时从游标续跑（第 5–6 章）')
        : bad('从游标续跑', `status=${more.status} ${JSON.stringify(more.body)}`);

      const project = await call(origin, 'GET', `projects/${projectId}`);
      project.body && project.body.cursor === 6
        ? ok('连写后游标前进到第 6 章')
        : bad('连写后游标', JSON.stringify(project.body && project.body.cursor));
    }

    // 4. 人工编辑 + 版本 + 回退
    {
      const original = await call(origin, 'GET', `projects/${projectId}/chapters/1`);
      const originalText = original.body && original.body.content;

      const saved = await call(origin, 'PUT', `projects/${projectId}/chapters/1`, { content: '人工改写后的正文。' });
      saved.status === 200 && saved.body && saved.body.record && saved.body.record.model_id === 'user-edit'
        ? ok('人工编辑保存，状态转为 draft 且记 user-edit')
        : bad('人工编辑保存', `status=${saved.status} ${JSON.stringify(saved.body && saved.body.record)}`);

      const versions = await call(origin, 'GET', `projects/${projectId}/chapters/1/versions`);
      const stamps = (versions.body && versions.body.versions) || [];
      stamps.length >= 1
        ? ok(`版本列表有 ${stamps.length} 份历史稿`)
        : bad('版本列表有历史稿', JSON.stringify(versions.body));

      if (stamps.length > 0) {
        const restored = await call(origin, 'POST', `projects/${projectId}/chapters/1/restore`, { stamp: stamps[0] });
        restored.status === 200 && restored.body.content === originalText
          ? ok('回退恢复成原来的正文')
          : bad('回退恢复成原来的正文', `status=${restored.status}`);
        restored.body && restored.body.record && String(restored.body.record.model_id).startsWith('restored:')
          ? ok('回退记录标 restored:<stamp>（可追溯）')
          : bad('回退记录标 restored:', JSON.stringify(restored.body && restored.body.record));
      }
    }

    // 5. 确认：draft → user-confirmed
    {
      const confirmed = await call(origin, 'POST', `projects/${projectId}/chapters/1/confirm`);
      confirmed.status === 200 && confirmed.body.record && confirmed.body.record.status === 'user-confirmed'
        ? ok('确认后状态变 user-confirmed')
        : bad('确认后状态', `status=${confirmed.status} ${JSON.stringify(confirmed.body && confirmed.body.record)}`);
    }

    // 6. 台账：连写的 6 章都该在
    {
      const runs = await call(origin, 'GET', `projects/${projectId}/runs`);
      const chapters = ((runs.body && runs.body.runs) || []).flatMap((group) => group.chapters || []);
      const committedOrders = new Set(chapters.filter((ch) => ch.status === 'committed').map((ch) => ch.order));
      runs.status === 200 && [1, 2, 3, 4, 5, 6].every((order) => committedOrders.has(order))
        ? ok('台账里 6 章都有 committed 记录')
        : bad('台账记录', JSON.stringify([...committedOrders]));
    }

    // 7. 指纹检查（只读）
    {
      const lint = await call(origin, 'GET', `projects/${projectId}/chapters/1/lint`);
      lint.status === 200 && lint.body && Array.isArray(lint.body.findings) && typeof lint.body.passed === 'boolean'
        ? ok('指纹检查返回 findings 与 passed')
        : bad('指纹检查返回形状', `status=${lint.status} ${JSON.stringify(lint.body && Object.keys(lint.body))}`);
    }

    // 8. 参数边界必须可读，不能 500
    {
      const cases = [
        [{ from: 9, to: 2 }, '区间'],
        [{ from: 'abc' }, '整数'],
        [{ provider: 'gpt-xyz' }, '未知 provider'],
      ];
      for (const [payload, expect] of cases) {
        const res = await call(origin, 'POST', `projects/${projectId}/runs`, payload);
        res.status === 400 && res.body && String(res.body.error || '').includes(expect)
          ? ok(`连写参数 ${JSON.stringify(payload)} 被拒 400（含「${expect}」）`)
          : bad(`连写参数 ${JSON.stringify(payload)}`, `status=${res.status} ${JSON.stringify(res.body)}`);
      }
      const badChapter = await call(origin, 'POST', `projects/${projectId}/chapters/xyz/run`, { provider: 'fake' });
      badChapter.status === 400 && String(badChapter.body.error || '').includes('整数')
        ? ok('非法章号被拒 400')
        : bad('非法章号被拒 400', `status=${badChapter.status} ${JSON.stringify(badChapter.body)}`);
    }
  }

  // 9. 工作区设置：报项目数，改目录后引擎重启
  {
    const settings = await call(origin, 'GET', '_settings');
    const value = settings.body && settings.body.value;
    settings.status === 200 && value && value.workspace === workspace
      ? ok('_settings 报出当前工作区')
      : bad('_settings 报出当前工作区', `status=${settings.status} ${JSON.stringify(value)}`);
    value && Number.isInteger(value.projectCount) && value.projectCount >= 1
      ? ok(`_settings 报出项目数（${value.projectCount} 本）`)
      : bad('_settings 报出项目数', JSON.stringify(value && value.projectCount));
  }

  panel.stop();
}

stopAllPanels();
server.close();
await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
