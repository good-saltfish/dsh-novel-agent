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

/**
 * 起一次连写并断言它是 202。
 *
 * 连写是后台任务：POST 只回 run_id，不等跑完。用同步语义断言会一直失败。
 */
async function startBatch(origin, projectId, body) {
  return call(origin, 'POST', `projects/${projectId}/runs`, body);
}

/** 轮询一次连写任务直到它不再是 running（返回最终状态体）。 */
async function waitBatch(origin, projectId, runId, timeoutMs = 60000) {
  if (!runId) return null;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const poll = await call(origin, 'GET', `projects/${projectId}/runs/${runId}`);
    last = poll.body;
    if (!last || last.status !== 'running') return last;
  }
  throw new Error(`连写任务 ${runId} 在 ${timeoutMs}ms 内没结束：${JSON.stringify(last)}`);
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

// 隔离插件设置：宿主按 %APPDATA%\dsh-novel-agent\settings.json 解析工作区，
// 不隔离的话本机已有的工作区会盖掉测试目录，测的就不是这里新建的书库了。
// dataDir() 是调用时读环境变量，所以在 apply 之前改就生效。
const appData = path.join(dataRoot, 'appdata');
await fs.mkdir(path.join(appData, 'dsh-novel-agent'), { recursive: true });
await fs.writeFile(
  path.join(appData, 'dsh-novel-agent', 'settings.json'),
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
      // 连写已改成后台任务：POST 立刻回 202 + run_id，必须轮询才知道结果。
      // 同步等它跑完会撞插件 300 秒硬超时（实测 10 章真模型 373 秒）。
      const batch = await startBatch(origin, projectId, { from: 2, to: 4, provider: 'fake' });
      batch.status === 202 && batch.body && batch.body.run_id
        ? ok('连写请求立刻返回 202 与 run_id')
        : bad('连写请求返回 202', `status=${batch.status} ${JSON.stringify(batch.body)}`);

      const batchDone = await waitBatch(origin, projectId, batch.body && batch.body.run_id);
      batchDone && batchDone.status === 'finished' && batchDone.written === 3 && batchDone.failures === 0
        ? ok('连写第 2–4 章全部提交')
        : bad('连写第 2–4 章', JSON.stringify(batchDone));

      const more = await startBatch(origin, projectId, { to: 6, provider: 'fake' });
      const moreDone = await waitBatch(origin, projectId, more.body && more.body.run_id);
      moreDone && moreDone.from === 5 && moreDone.written === 2
        ? ok('不传 from 时从游标续跑（第 5–6 章）')
        : bad('从游标续跑', `status=${more.status} ${JSON.stringify(moreDone)}`);

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

  // 9. 删除项目：DELETE 必须真的把目录删掉，且幂等
  //
  // 面板新加了删除按钮（用户要求「每个项目需要添加删除按钮功能」）。这条走真引擎，
  // 因为删除是 rmtree，写错了就是数据永久丢失 —— 不能只靠假 fetch 验组件。
  {
    const doomed = await call(origin, 'POST', 'projects/create', {
      kind: 'creation', title: '待删书', premise: '删给我看',
    });
    const doomedId = doomed.body && doomed.body.meta && doomed.body.meta.id;
    doomedId ? ok('建一本待删的书') : bad('建一本待删的书', JSON.stringify(doomed.body));

    if (doomedId) {
      // 注意：GET /api/projects 返回的是扁平 ProjectMeta（{id,kind,title,created_at}），
      // 没有外层 meta 包裹——这和单个项目端点 /api/projects/{id} 不一样。
      const idOf = (item) => (item && item.meta && item.meta.id) || (item && item.id);

      const before = await call(origin, 'GET', 'projects');
      const existed = Array.isArray(before.body) && before.body.some((item) => idOf(item) === doomedId);

      const removed = await call(origin, 'DELETE', `projects/${doomedId}`);
      removed.status === 200 && removed.body && removed.body.deleted === doomedId
        ? ok('DELETE 返回被删的项目 id')
        : bad('DELETE 返回被删的项目 id', `status=${removed.status} ${JSON.stringify(removed.body)}`);

      const after = await call(origin, 'GET', 'projects');
      const stillThere = Array.isArray(after.body) && after.body.some((item) => idOf(item) === doomedId);
      existed && !stillThere
        ? ok('删除后项目列表里不再有它')
        : bad('删除后项目列表里不再有它', `existed=${existed} stillThere=${stillThere}`);

      // 再删一次：store.delete 是幂等的，不该 500（界面重复点也不该炸）
      const again = await call(origin, 'DELETE', `projects/${doomedId}`);
      again.status === 200
        ? ok('重复删除是幂等的（不报 500）')
        : bad('重复删除是幂等的', `status=${again.status} ${JSON.stringify(again.body)}`);

      // 目录必须真没了（正文、摘要、台账、版本历史一起）
      const dir = path.join(workspace, 'projects', doomedId);
      const gone = await fs.stat(dir).then(() => false).catch(() => true);
      gone ? ok('项目目录连同正文摘要台账一起被删掉') : bad('项目目录被删掉', dir);
    }
  }

  // 10. 工作区设置：报项目数，改目录后引擎重启
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

  // 11. 引擎被杀掉后能自愈。
  //
  // 真实症状（用户报的）：面板显示「生成骨架：无法连接引擎
  // （http://127.0.0.1:62238）：fetch failed」。那个端口号早已失效 —— 引擎是
  // 长驻 python 子进程，会被宿主回收、被系统杀掉、或自己退出。以前插件只把
  // 失效端口抛给用户，用户能做的只有重启宿主。
  // 现在 proxyToPanel 会「清进程 → 重拉 → 重发同一次请求」。
  {
    const before = await call(origin, 'GET', '_status');
    const wasRunning = !!(before.body && before.body.value && before.body.value.running);
    wasRunning ? ok('自愈前引擎在跑') : bad('自愈前引擎在跑', JSON.stringify(before.body));

    panel.stop();
    await new Promise((r) => setTimeout(r, 600));

    const afterKill = await call(origin, 'GET', '_status');
    !(afterKill.body && afterKill.body.value && afterKill.body.value.running)
      ? ok('杀掉后 _status 报 running=false')
      : bad('杀掉后 _status 报 running=false', JSON.stringify(afterKill.body && afterKill.body.value));

    // 关键断言：同一请求应该由插件自动重拉引擎后成功，而不是抛 502。
    const revived = await call(origin, 'GET', 'projects');
    revived.status === 200 && Array.isArray(revived.body)
      ? ok('引擎被杀后，下一次请求自动重拉并成功')
      : bad('引擎被杀后自动重拉', `status=${revived.status} ${JSON.stringify(revived.body)}`);

    // POST 也要能重试。请求体在第一次尝试前已读进 Buffer，所以重发是原样重发；
    // 这条单独验，因为「带 body 的重试」最容易写成「重发时 body 已被消费」。
    panel.stop();
    await new Promise((r) => setTimeout(r, 600));
    const genAfterKill = await call(origin, 'POST', `projects/${projectId}/generate`, { provider: 'fake', chapter_count: 5 });
    genAfterKill.status === 200 && genAfterKill.body && genAfterKill.body.meta
      ? ok('引擎被杀后，带请求体的 POST 也能自动重拉并成功')
      : bad('带 body 的 POST 重试', `status=${genAfterKill.status} ${JSON.stringify(genAfterKill.body)}`);

    const afterRevive = await call(origin, 'GET', '_status');
    afterRevive.body && afterRevive.body.value && afterRevive.body.value.running
      ? ok('自愈后引擎在跑且端口已更新')
      : bad('自愈后引擎在跑', JSON.stringify(afterRevive.body && afterRevive.body.value));

    // 外部杀掉（不是我们主动 stop）必须记成「非主动」，否则界面会把真崩溃
    // 当成「你自己点了重启」，把问题藏起来。
    const child = panel.child;
    if (child) {
      child.kill();
      await new Promise((r) => setTimeout(r, 800));
      const exitRecord = await call(origin, 'GET', '_status');
      const exit = exitRecord.body && exitRecord.body.value && exitRecord.body.value.lastExit;
      exit && exit.intentional === false
        ? ok(`外部杀掉被记成非主动退出（code=${exit.code} signal=${exit.signal}）`)
        : bad('外部杀掉记成非主动退出', JSON.stringify(exit));
    } else {
      bad('外部杀掉记成非主动退出', '拿不到子进程句柄');
    }
  }

  panel.stop();
}

stopAllPanels();
server.close();
await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
