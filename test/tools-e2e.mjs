/**
 * 工具面验证：7 个 novel_* 工具都要真能注册、真能调通引擎。
 *
 * 为什么单独测：工具是给模型用的，模型不会重试也不会看日志。
 * 一个描述里写了「返回 verdict 与证据」但实现只返回 HTTP 码的工具，
 * 表现是模型开始瞎猜——这比工具不存在更糟。
 *
 * 用假 tools 服务收集注册定义，再用真引擎逐个 execute 一遍。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const host = await import('../lib/host.js');
const { registerNovelTools, NOVEL_TOOL_NAMES } = await import('../lib/tools.js');
const { panelFor, stopAllPanels } = host.__testing;

let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };
const bad = (name, detail) => { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); };

function fakeCtx() {
  let handler = null;
  const registered = [];
  const tools = { register(def) { registered.push(def); return () => {}; } };
  const ctx = {
    webServer: { register(spec) { handler = spec.handler; return () => { handler = null; }; } },
    connection: { requestRejection: () => null },
    effect(fn) { fn(); return () => {}; },
    inject(_names, cb) { cb({ tools }); },
  };
  return { ctx, getHandler: () => handler, registered };
}

const dataRoot = path.join(os.tmpdir(), 'novel-studio-tools-' + Date.now());
const workspace = path.join(dataRoot, 'ws');
await fs.mkdir(workspace, { recursive: true });
const appData = path.join(dataRoot, 'appdata');
await fs.mkdir(path.join(appData, 'dsh-novel-agent'), { recursive: true });
await fs.writeFile(path.join(appData, 'dsh-novel-agent', 'settings.json'), JSON.stringify({ workspace }), 'utf8');
process.env.APPDATA = appData;

const { ctx, registered } = fakeCtx();
host.apply(ctx);

/* 1. 注册面：7 个工具都在，且每个都有必需的四个字段 */
{
  const names = registered.map((def) => def.name);
  const missing = NOVEL_TOOL_NAMES.filter((name) => !names.includes(name));
  missing.length === 0
    ? ok(`注册了全部 ${NOVEL_TOOL_NAMES.length} 个工具`)
    : bad('注册全部工具', `缺：${missing.join('、')}`);
  const shapeBad = registered.filter((def) => !def.description || !def.parameters
    || !def.output || !def.output.schema || typeof def.output.render !== 'function'
    || typeof def.execute !== 'function');
  shapeBad.length === 0
    ? ok('每个工具都有 description/parameters/output.schema/output.render/execute')
    : bad('工具形状完整', shapeBad.map((d) => d.name).join('、'));
  // parameters 必须是已展开的原生 JSON Schema：出现 $ref 宿主会拒绝编译。
  const withRef = registered.filter((def) => JSON.stringify(def.parameters).includes('"$ref"'));
  withRef.length === 0
    ? ok('parameters 里没有 $ref（原生 JSON Schema）')
    : bad('parameters 无 $ref', withRef.map((d) => d.name).join('、'));
}

const tool = (name) => registered.find((def) => def.name === name);

/* 2. 真跑：建项目 → 骨架 → 验收 → 上下文 → 生成 → 连写 → 检查 */
const panel = panelFor(workspace);
try {
  await panel.ensureStarted();
} catch (error) {
  bad('引擎能起来', String(error && error.message));
  stopAllPanels();
  process.exit(1);
}

let projectId = null;
{
  const created = await tool('novel_project_create').execute({
    title: '工具验证书', premise: '一句话前提', genre: '悬疑', chapter_count: 8, provider: 'fake',
  });
  const text = created && created.text ? created.text : '';
  const match = text.match(/(creation-[^\s「」]+)/);
  projectId = match ? match[1] : null;
  projectId
    ? ok('novel_project_create 建出项目并返回 id')
    : bad('novel_project_create 返回 id', text.slice(0, 300));
  // 早前读的是 `scaffold`/`parts`（服务端其实返回 `draft`），结果永远是
  // 「骨架生成结果未返回部件清单」却照样算通过。fake provider 生成的是完整
  // 骨架，四个必备部件必须都列出来。
  {
    const PARTS = ['定位', '主角', '金手指', '细纲'];
    const absent = PARTS.filter((label) => !text.includes(label));
    text.includes('骨架部件') && absent.length === 0 && !text.includes('未返回部件清单')
      ? ok(`novel_project_create 报出骨架部件（${PARTS.join('/')}）`)
      : bad('novel_project_create 报出骨架部件', `缺：${absent.join('、')}｜${text.slice(0, 300)}`);
  }
}

if (projectId) {
  {
    const accepted = await tool('novel_accept_skeleton').execute({ project_id: projectId });
    accepted && accepted.text && accepted.text.includes('验收')
      ? ok('novel_accept_skeleton 返回验收结论')
      : bad('novel_accept_skeleton', String(accepted && accepted.text).slice(0, 300));
  }
  {
    const pack = await tool('novel_context_pack').execute({ project_id: projectId, order: 2 });
    const text = pack && pack.text ? pack.text : '';
    // 只断言「有上下文包」太弱：早前读错键时整段只剩一行索引文档数，照样能过。
    // 这里逐个要求五块真的出现，缺任何一块都算失败。
    const BLOCKS = ['定位', '主角', '金手指', '细纲', '前情', '检索命中', '未回收伏笔'];
    const absent = BLOCKS.filter((label) => !text.includes(`${label}`));
    text.includes('上下文包') && absent.length === 0 && !text.includes('未注入：')
      ? ok(`novel_context_pack 返回五块（${BLOCKS.length} 个标签齐全）且没有未注入部件`)
      : bad('novel_context_pack 五块齐全', `缺：${absent.join('、')}｜${text.slice(0, 400)}`);
  }
  {
    const gen = await tool('novel_chapter_generate').execute({ project_id: projectId, order: 1 });
    const text = gen && gen.text ? gen.text : '';
    text.includes('committed') || text.includes('提交')
      ? ok('novel_chapter_generate 走章事务并报结果')
      : bad('novel_chapter_generate', text.slice(0, 400));
  }
  {
    const batch = await tool('novel_chapters_run').execute({ project_id: projectId, from: 2, to: 4 });
    const text = batch && batch.text ? batch.text : '';
    text.includes('写入 3 章') && !text.includes('未过门')
      ? ok('novel_chapters_run 连写 3 章且全部过门')
      : bad('novel_chapters_run', text.slice(0, 500));
    // 描述承诺了「逐章 status/verdict/尝试次数/字数」，实现必须真给
    text.includes('verdict=') && text.includes('尝试') && text.includes('字')
      ? ok('novel_chapters_run 逐章给 verdict/尝试次数/字数')
      : bad('novel_chapters_run 逐章细节', text.slice(0, 400));
  }
  {
    const check = await tool('novel_chapter_check').execute({ project_id: projectId, order: 1 });
    const text = check && check.text ? check.text : '';
    text.includes('规则版本') && text.includes('阈值')
      ? ok('novel_chapter_check 返回逐条规则实测/阈值')
      : bad('novel_chapter_check', text.slice(0, 400));
  }
  {
    const list = await tool('novel_projects_list').execute({});
    const text = list && list.text ? list.text : '';
    text.includes('工具验证书')
      ? ok('novel_projects_list 列出刚建的书')
      : bad('novel_projects_list', text.slice(0, 300));
  }
}

/* 3. 参数校验必须在模型看到之前就拦住，别让它拿错误参数撞引擎 */
{
  const cases = [
    ['novel_chapter_generate', { project_id: 'x' }, 'order 必须是'],
    ['novel_chapter_check', { project_id: 'x', order: 0 }, 'order 必须是'],
    ['novel_chapters_run', {}, 'project_id 必填'],
  ];
  for (const [name, args, expect] of cases) {
    let message = '';
    try {
      await tool(name).execute(args);
    } catch (error) {
      message = String(error && error.message);
    }
    message.includes(expect)
      ? ok(`${name} 参数校验：${expect}`)
      : bad(`${name} 参数校验`, `得到「${message}」`);
  }
}

panel.stop();
stopAllPanels();
await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
