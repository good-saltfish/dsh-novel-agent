/**
 * 真引擎验证：骨架补齐 + 部件编辑 + 连写。
 *
 * 全程走插件 HTTP 门，不碰假数据——这三个问题用户都是在真机上撞到的，
 * 只用假 fetch 测过就等于没测。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appData = path.join(os.tmpdir(), `ns-fix-${process.pid}`);
process.env.APPDATA = appData;
fs.mkdirSync(appData, { recursive: true });
const ws = path.join(appData, 'workspace');
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({ workspace: ws }), 'utf8');

const host = await import('../lib/host.js');

const T = host.__testing;
let server = null;
let origin = '';

function makeCtx() {
  return {
    webServer: { register(spec) { server = http.createServer((req, res) => spec.handler(req, res)); return () => {}; } },
    connection: { requestRejection() { return null; } },
    effect(fn) { fn(); return () => {}; },
    inject(_names, cb) { cb({ tools: null }); },
    get() { return undefined; },
  };
}

host.apply(makeCtx());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;

const passed = [];
const failed = [];
function check(name, ok, detail) {
  if (ok) passed.push(name);
  else failed.push(`${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
}

/**
 * 轮询一次连写任务直到它不再是 running。
 *
 * 连写已改成后台任务（POST 回 202 + run_id），同步断言会一直失败。
 */
async function waitBatch(projectId, runId, timeoutMs = 60000) {
  if (!runId) return null;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const poll = await call('GET', `projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`);
    last = poll.body;
    if (!last || last.status !== 'running') return last;
  }
  throw new Error(`连写任务 ${runId} 在 ${timeoutMs}ms 内没结束：${JSON.stringify(last)}`);
}

async function call(method, tail, body) {
  const res = await fetch(`${origin}/novel-studio/api/${tail}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const value = parsed && parsed.ok === true && 'value' in parsed ? parsed.value : parsed;
  return { status: res.status, body: value, raw: text };
}

try {
  /* --- 1. 工作区隔离生效 --- */
  const status = await call('GET', '_status');
  // _status 返回 {ok:true, value: panel.status()}，call() 已解包成 status() 对象本身。
  check('状态返回的 workspace 是测试目录（APPDATA 隔离生效）',
    String(status.body.workspace).startsWith(appData),
    status.body.workspace);

  /* --- 2. 新建项目：先有项目，骨架才是空的 --- */
  const created = await call('POST', 'projects/create', { kind: 'creation', title: '补骨架验证', premise: '一句话前提', genre: '都市' });
  check('新建项目 201', created.status === 201, created.raw.slice(0, 200));
  const pid = created.body.meta.id;
  check('拿到项目 id', typeof pid === 'string' && pid.length > 0, pid);

  /* --- 3. 空骨架：连写必须被明确拒绝，而不是写出一堆无根正文 --- */
  // 空骨架时连写必须被拒（400），而且是在参数校验阶段就拒，不会起后台任务。
  const emptyRun = await call('POST', `projects/${encodeURIComponent(pid)}/runs`, { from: 1, to: 3, provider: 'fake' });
  check('空骨架时连写被拒且原因明确',
    emptyRun.status === 400 && JSON.stringify(emptyRun.body).includes('细纲'),
    `${emptyRun.status} ${emptyRun.raw.slice(0, 120)}`);

  /* --- 4. 补骨架：generate + accept-skeleton 两步 --- */
  const gen = await call('POST', `projects/${encodeURIComponent(pid)}/generate`, { provider: 'fake', chapter_count: 20 });
  check('骨架生成 200', gen.status === 200, gen.raw.slice(0, 160));
  check('骨架生成了 20 章细纲', Array.isArray(gen.body.draft.chapters) && gen.body.draft.chapters.length === 20,
    String((gen.body.draft || {}).chapters && gen.body.draft.chapters.length));
  check('生成后五部件都有内容',
    ['positioning', 'volume', 'protagonist', 'golden_finger'].every((k) => gen.body.draft[k] !== null),
    JSON.stringify(Object.keys(gen.body.draft)));

  const acc = await call('POST', `projects/${encodeURIComponent(pid)}/accept-skeleton`, {});
  check('自动验收 200', acc.status === 200, `${acc.status} ${acc.raw.slice(0, 200)}`);
  check('五个部件全部入库', Array.isArray(acc.body.accepted) && acc.body.accepted.length === 5,
    JSON.stringify(acc.body && acc.body.accepted));
  check('没有部件被拒', Array.isArray(acc.body.rejected) && acc.body.rejected.length === 0,
    JSON.stringify(acc.body && acc.body.rejected));

  /* --- 5. 部件编辑：改主角占位名，PUT 后应变 human-confirmed --- */
  const before = await call('GET', `projects/${encodeURIComponent(pid)}`);
  check('主角初始是自动验收', before.body.confirmed_parts.protagonist === 'auto-accepted',
    before.body.confirmed_parts.protagonist);
  const prot = { ...before.body.draft.protagonist, name: '沈砚' };
  const saved = await call('PUT', `projects/${encodeURIComponent(pid)}/parts/protagonist`, { content: prot });
  check('部件保存 200', saved.status === 200, saved.raw.slice(0, 160));
  check('保存后主角名真的改了', saved.body.draft.protagonist.name === '沈砚',
    saved.body.draft.protagonist.name);
  check('保存后标为已人工确认', saved.body.confirmed_parts.protagonist === 'human-confirmed',
    saved.body.confirmed_parts.protagonist);

  /* --- 6. 改完后上下文包必须用新值，而不是旧候选 --- */
  const pack = await call('GET', `projects/${encodeURIComponent(pid)}/chapters/1/context`);
  check('上下文包注入主角', pack.status === 200 && !!pack.body.protagonist, `${pack.status}`);
  check('上下文包里的主角名是改后的值', pack.body.protagonist && pack.body.protagonist.name === '沈砚',
    pack.body.protagonist && pack.body.protagonist.name);
  check('上下文包无被丢弃部件', Array.isArray(pack.body.dropped) && pack.body.dropped.length === 0,
    JSON.stringify(pack.body.dropped));

  /* --- 7. 连写：这次应该真的能写 --- */
  const run = await call('POST', `projects/${encodeURIComponent(pid)}/runs`, { from: 1, to: 3, provider: 'fake' });
  const runDone = run.status === 202 && run.body && run.body.run_id
    ? await waitBatch(pid, run.body.run_id)
    : null;
  // 连写是后台任务：POST 回 202 + run_id，结果在 runDone 里。
  check('补骨架后连写立刻返回 202', run.status === 202, `${run.status} ${run.raw.slice(0, 200)}`);
  check('连写 3 章全部提交', !!runDone && runDone.written === 3 && runDone.failures === 0,
    JSON.stringify(runDone && { written: runDone.written, failures: runDone.failures }));
  check('每章都有 verdict', ((runDone && runDone.chapters) || []).every((ch) => typeof ch.verdict === 'string'),
    JSON.stringify(((runDone && runDone.chapters) || []).map((ch) => ch.verdict)));

  /* --- 8. 版本端点存在且可用（用户说「没有回退按钮」，回退要靠它） --- */
  const versions = await call('GET', `projects/${encodeURIComponent(pid)}/chapters/1/versions`);
  check('版本端点可用', versions.status === 200 && Array.isArray(versions.body.versions),
    `${versions.status} ${versions.raw.slice(0, 120)}`);

  /* --- 9. 回退：先改正文产生第二版，再回退 --- */
  const ch1 = await call('GET', `projects/${encodeURIComponent(pid)}/chapters/1`);
  const edited = `${ch1.body.content}\n\n【人工补写】这一行是测试加的。`;
  const put = await call('PUT', `projects/${encodeURIComponent(pid)}/chapters/1`, { content: edited });
  check('人工编辑正文 200', put.status === 200, `${put.status} ${put.raw.slice(0, 120)}`);
  const v2 = await call('GET', `projects/${encodeURIComponent(pid)}/chapters/1/versions`);
  check('编辑后产生历史版本', v2.body.versions.length >= 1, JSON.stringify(v2.body.versions));
  const restore = await call('POST', `projects/${encodeURIComponent(pid)}/chapters/1/restore`, { stamp: v2.body.versions[0] });
  check('回退 200', restore.status === 200, `${restore.status} ${restore.raw.slice(0, 160)}`);
  check('回退后正文不再含人工补写', !String(restore.body.content).includes('【人工补写】'),
    String(restore.body.content).slice(-80));
  check('回退后状态回到 draft', restore.body.record.status === 'draft', restore.body.record.status);

  /* --- 10. 台账 --- */
  const runs = await call('GET', `projects/${encodeURIComponent(pid)}/runs`);
  check('台账端点可用且有记录', runs.status === 200 && Array.isArray(runs.body.runs) && runs.body.runs.length >= 1,
    `${runs.status} ${JSON.stringify((runs.body || {}).runs && runs.body.runs.length)}`);
} finally {
  T.stopAllPanels();
  if (server) server.close();
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(appData, { recursive: true, force: true }); } catch {}
}

console.log(`\n通过 ${passed.length} 项：`);
for (const name of passed) console.log(`  [ok] ${name}`);
if (failed.length) {
  console.log(`\n失败 ${failed.length} 项：`);
  for (const name of failed) console.log(`  [FAIL] ${name}`);
}
process.exit(failed.length === 0 ? 0 : 1);
