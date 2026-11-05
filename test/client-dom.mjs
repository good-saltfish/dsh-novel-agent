/**
 * 在 Node 里把 client.js 的组件真跑一遍（不需要浏览器）。
 *
 * 为什么必须这样测：右栏组件在浏览器里抛异常的表现是「一片空白」或「点按钮没反应」，
 * 而宿主控制台没人看。表单里每个 input 的 onChange、每个分支的 props 都要真执行一次，
 * 才能确认「面板里能手动建项目」这件事成立。
 *
 * 做法：伪造 window.__ModuleLoader__ + 一个极小的 React（useState/useEffect/useCallback），
 * 把组件树渲染成普通对象，再手动触发 onClick / onChange，看状态变化后是否仍然正常。
 *
 * 关键：同一个元素对象必须反复 render（hook 状态挂在元素对象上），
 * 每次都新建元素等于每次重置 state，测不到任何交互。
 *
 * 跑法：node D:\myproject\_scratch\client-dom-check.mjs
 */
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ */
/* 极小 React                                                          */
/* ------------------------------------------------------------------ */

const hookStore = new Map(); // 元素 key -> hooks 数组
let renderingKey = null;
let hookIndex = 0;
const pendingEffects = [];

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) };
}

const React = {
  createElement,
  useState(initial) {
    const key = renderingKey;
    const hooks = hookStore.get(key) || [];
    const i = hookIndex++;
    if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
    hookStore.set(key, hooks);
    const value = hooks[i];
    const setter = (next) => {
      const arr = hookStore.get(key) || [];
      arr[i] = typeof next === 'function' ? next(arr[i]) : next;
      hookStore.set(key, arr);
    };
    return [value, setter];
  },
  useCallback(fn) { hookIndex++; return fn; },
  useEffect(fn) { pendingEffects.push(fn); hookIndex++; },
  useMemo(fn) { hookIndex++; return fn(); },
  useRef(v) {
    // 必须存进 hooks 数组：每次 render 新建一个对象等于每次重置，ref 就失去意义
    // （本轮实测：touched.current 永远 false，用户手选会被后台刷新覆盖）。
    const key = renderingKey;
    const hooks = hookStore.get(key) || [];
    const i = hookIndex++;
    if (!(i in hooks)) hooks[i] = { current: v };
    hookStore.set(key, hooks);
    return hooks[i];
  },
};

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

let instanceSeq = 0;
const instanceKeys = new Map();

function keyOf(element) {
  if (!instanceKeys.has(element)) instanceKeys.set(element, `c${instanceSeq++}`);
  return instanceKeys.get(element);
}

function render(element) {
  if (element == null || element === false || element === true) return null;
  if (typeof element === 'string' || typeof element === 'number') return { text: String(element) };
  if (Array.isArray(element)) return element.map(render).filter(Boolean);

  const { type, props, children } = element;

  if (typeof type === 'function') {
    const key = keyOf(element);
    const prevKey = renderingKey;
    const prevIndex = hookIndex;
    renderingKey = key;
    hookIndex = 0;
    let out;
    try {
      out = type({ ...props, children: children.length === 1 ? children[0] : children });
    } finally {
      renderingKey = prevKey;
      hookIndex = prevIndex;
    }
    return render(out);
  }

  const renderedChildren = children.map(render).filter(Boolean);
  const node = { tag: type, props: props || {}, children: renderedChildren };
  // 文本必须在这里算好：用 getter 会让 `'text' in node` 恒为真，textOf 无限递归。
  node.text = renderedChildren.map(textOf).join('');
  return node;
}

function textOf(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.children || []).map(textOf).join('');
}

function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (const child of node.children || []) walk(child, fn);
}

function findAll(root, tag, needle) {
  const out = [];
  walk(root, (node) => {
    if (node.tag === tag && (needle === undefined || textOf(node).includes(needle))) out.push(node);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 装载 client.js                                                      */
/* ------------------------------------------------------------------ */

let exportsObj = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      exportsObj = spec.factory((name) => {
        if (name === 'react') return React;
        throw new Error(`未预期的 require：${name}`);
      });
    },
  },
};
// document 必须给一个最小实现：routeUrl() 要读 document.baseURI。
// 缺了它，组件里每次数据加载都会走进「无法连接小说引擎」的错误分支——
// 看起来「渲染成功」，实际测的全是错误态。这是本轮实测踩出来的。
const styleNodes = [];
globalThis.document = {
  baseURI: 'http://localhost/',
  head: { appendChild(node) { styleNodes.push(node); } },
  querySelector() { return null; },
  createElement(tag) { return { tag, dataset: {}, textContent: '' }; },
};

/* 假 fetch：让组件里的异步 load 真能走完，否则 ProjectList 永远停在「加载中…」，
   空列表那条分支（正是用户第一次打开时的状态）就测不到。 */
let fetchScript = [];
globalThis.fetch = async (url, init) => {
  const step = fetchScript.shift();
  const body = step === undefined ? [] : step;
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); },
  };
};
fetchScript = [];

/** 等异步 setState 落定后重新渲染。 */
async function settle(element) {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  return mount(element);
}

const h = React.createElement;

const CLIENT = pathToFileURL('D:/myproject/dsh-novel-studio/lib/client.js').href;
await import(CLIENT);
if (!exportsObj || !exportsObj.__testing) throw new Error('client.js 没有导出 __testing');

const T = exportsObj.__testing;

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

const passed = [];
const failed = [];
function check(name, ok, detail) {
  if (ok) passed.push(name);
  else failed.push(`${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
}

/** 渲染同一个元素并跑完 effect；effect 可能触发 fetch，这里只关心不抛异常。 */
function mount(element) {
  pendingEffects.length = 0;
  const tree = render(element);
  for (const fn of pendingEffects.splice(0)) {
    try {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanup();
    } catch (e) {
      throw new Error(`effect 抛异常：${e.message}`);
    }
  }
  return tree;
}

/* --- 1. CreateForm：折叠 → 展开 ------------------------------------------- */

const formElement = h(T.CreateForm, { busy: false, onCreated() {} });
let tree = mount(formElement);
const newBtn = findAll(tree, 'button', '新建项目');
check('折叠态有「＋ 新建项目」按钮', newBtn.length === 1, newBtn.length);
check('折叠态没有输入框', findAll(tree, 'input').length === 0);

newBtn[0].props.onClick();
tree = mount(formElement);
check('点开后出现「新建创作项目」标题', findAll(tree, 'div', '新建创作项目').length > 0);

/* --- 2. 字段齐全 ----------------------------------------------------------- */

const inputs = findAll(tree, 'input');
check('表单有 4 个文本输入（书名/前提/题材/章数）', inputs.length === 4, inputs.length);
const selects = findAll(tree, 'select');
check('表单有 1 个骨架来源下拉', selects.length === 1, selects.length);
check('下拉有离线/LLM 两项', (selects[0].children || []).length === 2,
  (selects[0].children || []).map((c) => c.props && c.props.value));
check('有「创建」按钮', findAll(tree, 'button', '创建').length === 1);
check('有「取消」按钮', findAll(tree, 'button', '取消').length === 1);

/* --- 3. onChange 真能改值 -------------------------------------------------- */

const titleInput = inputs[0];
check('书名输入框有 onChange', typeof titleInput.props.onChange === 'function');
titleInput.props.onChange({ target: { value: '面板测试书' } });
tree = mount(formElement);
check('onChange 后书名写进受控值',
  findAll(tree, 'input')[0].props.value === '面板测试书',
  findAll(tree, 'input')[0].props.value);

/* --- 4. 空书名被拦，不发请求 ----------------------------------------------- */

titleInput.props.onChange({ target: { value: '   ' } });
tree = mount(formElement);
await findAll(tree, 'button', '创建')[0].props.onClick();
tree = mount(formElement);
check('空书名时显示错误提示', findAll(tree, 'div', '书名不能为空').length > 0, textOf(tree).slice(0, 200));

/* --- 5. 非法章数被拦 ------------------------------------------------------- */

titleInput.props.onChange({ target: { value: '面板测试书' } });
const countInput = findAll(tree, 'input')[3];
countInput.props.onChange({ target: { value: 'abc' } });
tree = mount(formElement);
await findAll(tree, 'button', '创建')[0].props.onClick();
tree = mount(formElement);
check('章数非整数时显示错误提示',
  findAll(tree, 'div', '章数必须是').length > 0,
  textOf(tree).slice(0, 300));

/* --- 6. 取消能收起来 ------------------------------------------------------- */

await findAll(tree, 'button', '取消')[0].props.onClick();
tree = mount(formElement);
check('点取消后回到折叠态',
  findAll(tree, 'button', '新建项目').length === 1 && findAll(tree, 'input').length === 0);

/* --- 7. 空项目列表仍给出新建入口 ------------------------------------------ */

fetchScript = [[]]; // GET projects 返回空数组
const listElement = h(T.ProjectList, { busy: false, refreshKey: 0, onPick() {}, onCreated() {} });
let emptyList = mount(listElement);
emptyList = await settle(listElement);
check('空列表仍渲染新建表单', findAll(emptyList, 'button', '新建项目').length === 1);
check('空列表提示指向新建按钮', textOf(emptyList).includes('点上面的'), textOf(emptyList).slice(0, 300));

/* --- 8. StudioTab 能渲染 --------------------------------------------------- */

const tabElement = h(T.StudioTab, { sessionId: 'test' });
const tabTree = mount(tabElement);
check('StudioTab 渲染出标题', textOf(tabTree).includes('小说工作台'));
check('StudioTab 有刷新按钮', findAll(tabTree, 'button', '刷新').length >= 1);
check('StudioTab 有新建入口', findAll(tabTree, 'button', '新建项目').length >= 1);
check('StudioTab 顶栏一直显示模型（未选时也要可见）',
  textOf(tabTree).includes('未选模型'), textOf(tabTree).slice(0, 200));

/* --- 8b. 模型页 ----------------------------------------------------------- */

// 这个 harness 每次 mount 都会重跑 effect（等于重新拉一次），所以同一份响应要给足次数。
const modelPayload = {
  ok: true,
  providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4.1-flash', name: 'V4.1 Flash' }] }],
  current: { provider: 'deepseek', model: 'v4.1-flash', source: 'default' },
  saved: null,
  bridge: 'http://127.0.0.1:1/v1',
};
fetchScript = Array.from({ length: 12 }, () => modelPayload);
const modelElement = h(T.ModelScreen, { busy: false, onBack() {} });
let modelTree = mount(modelElement);
modelTree = await settle(modelElement);
check('模型页渲染出当前模型', textOf(modelTree).includes('v4.1-flash'), textOf(modelTree).slice(0, 240));
check('模型页说明来源是「跟随 DSH 默认」', textOf(modelTree).includes('跟随 DSH 默认'));
// 没选供应商时没有模型可选，模型字段是禁用的手填框；选了才变下拉。
check('模型页有供应商下拉', findAll(modelTree, 'select').length === 1,
  findAll(modelTree, 'select').length);
check('未选供应商时模型字段是禁用手填框',
  findAll(modelTree, 'input').length === 1
  && findAll(modelTree, 'input')[0].props.disabled === true);
check('模型页有「用这个模型」与「恢复跟随」两个按钮',
  findAll(modelTree, 'button', '用这个模型').length === 1
  && findAll(modelTree, 'button', '恢复跟随').length === 1);
check('未选供应商时「用这个模型」被禁用',
  findAll(modelTree, 'button', '用这个模型')[0].props.disabled === true);
check('模型页有「测一下这个模型」按钮',
  findAll(modelTree, 'button', '测一下这个模型').length === 1);
check('未选供应商时「测一下这个模型」也被禁用',
  findAll(modelTree, 'button', '测一下这个模型')[0].props.disabled === true);
check('模型页有选型参考（不是推荐榜）',
  textOf(modelTree).includes('选型参考'), textOf(modelTree).slice(0, 400));
check('选型参考点名了实测过的坑（glm 字数服从度）',
  textOf(modelTree).includes('1311'), textOf(modelTree).slice(0, 600));
check('选型参考说明「测一下」测不出字数服从度',
  textOf(modelTree).includes('测不出字数服从度'));

/* 选供应商后模型下拉应带上该供应商的模型 */
findAll(modelTree, 'select')[0].props.onChange({ target: { value: 'deepseek' } });
modelTree = mount(modelElement);
// 关键：onChange 之后还要等 effect 把数据拉回来，否则读到的是上一帧。
modelTree = await settle(modelElement);
const modelSelect = findAll(modelTree, 'select')[1];
check('选供应商后模型下拉自动选中第一个模型',
  modelSelect.props.value === 'v4.1-flash', modelSelect.props.value);
check('选好之后「用这个模型」可点',
  findAll(modelTree, 'button', '用这个模型')[0].props.disabled === false);
check('模型页有返回按钮', findAll(modelTree, 'button', '返回项目列表').length === 1);

/* 空供应商列表：不崩，且提示指向 DSH 设置 */
fetchScript = Array.from({ length: 12 }, () => ({ ok: true, providers: [], current: null, saved: null, bridge: null }));
const bareElement = h(T.ModelScreen, { busy: false, onBack() {} });
let bareTree = mount(bareElement);
bareTree = await settle(bareElement);
check('没有供应商时不崩', textOf(bareTree).includes('单独指定'), textOf(bareTree).slice(0, 200));
check('没有供应商时提示去 DSH 设置', textOf(bareTree).includes('DSH 设置'));
check('没有模型时给出警告而不是假装可用', textOf(bareTree).includes('还没有可用模型'));

/* --- 9. StudioEntry 无 sidebar 不抛 --------------------------------------- */

const entryElement = h(T.StudioEntry, { sidebar: undefined });
const entry = mount(entryElement);
check('StudioEntry 无 sidebar 时能渲染', textOf(entry) === '小说');
entry.props.onClick();
check('StudioEntry 无 sidebar 时点击不抛异常', true);

/* --- 10. 展示函数对 null 安全 --------------------------------------------- */

check('partText(null) 不抛', T.partText('positioning', null) === '');
check('outlineText(null) 不抛', T.outlineText(null) === '');
check('recordChars(null) 返回 null', T.recordChars(null) === null);
check('recordTime(null) 返回空串', T.recordTime(null) === '');
check('chapterOrders(null) 返回空数组', Array.isArray(T.chapterOrders(null)) && T.chapterOrders(null).length === 0);
check('outlineCount(null) 返回 0', T.outlineCount(null) === 0);
check('stateOf(null) 返回 null', T.stateOf(null, 'positioning') === null);

/* --- 11. ContextPackView 对空包安全 --------------------------------------- */

const packElement = h(T.ContextPackView, { projectId: 'x', order: 1, onClose() {} });
const packTree = mount(packElement);
check('ContextPackView 首次渲染不抛（数据未到时显示加载中）',
  textOf(packTree).includes('加载上下文包'), textOf(packTree).slice(0, 120));

/* --- 12. 章节页：生成/候选/确认/编辑/版本/台账 都要有入口 ------------------ */

const chapterPayload = {
  record: { order: 1, title: '裂口', status: 'auto-accepted', word_count: 2798, model_id: 'rule:fake-chapter', updated_at: '2026-11-01T23:19:11' },
  content: '第 1 章正文。',
};
fetchScript = Array.from({ length: 30 }, () => chapterPayload);
const chapterElement = h(T.ChapterView, { projectId: 'p1', order: 1, busy: false, onBack() {} });
let chapterTree = mount(chapterElement);
chapterTree = await settle(chapterElement);
check('章节页显示状态与字数', textOf(chapterTree).includes('auto-accepted') && textOf(chapterTree).includes('2798 字'));
check('章节页有「生成（过闸门）」按钮', findAll(chapterTree, 'button', '生成（过闸门）').length === 1);
check('章节页有「只产候选」按钮', findAll(chapterTree, 'button', '只产候选').length === 1);
check('章节页有「确认」按钮（未确认时）', findAll(chapterTree, 'button', '确认').length === 1);
check('章节页有「编辑」「版本」「台账」三个入口',
  findAll(chapterTree, 'button', '编辑').length === 1
  && findAll(chapterTree, 'button', '版本').length === 1
  && findAll(chapterTree, 'button', '台账').length === 1);
check('章节页默认不是编辑态（无 textarea）', findAll(chapterTree, 'textarea').length === 0);

/* 点「编辑」应出现 textarea 且预填正文 */
findAll(chapterTree, 'button', '编辑')[0].props.onClick();
chapterTree = mount(chapterElement);
check('点编辑后出现正文编辑框', findAll(chapterTree, 'textarea').length === 1);
check('编辑框预填当前正文', findAll(chapterTree, 'textarea')[0].props.value === '第 1 章正文。');

/* 点「版本」应列出历史版本 */
fetchScript = Array.from({ length: 30 }, () => ({ order: 1, versions: ['20261101-231911-000001'] }));
await findAll(chapterTree, 'button', '版本')[0].props.onClick();
chapterTree = await settle(chapterElement);
check('版本面板列出历史版本', textOf(chapterTree).includes('20261101-231911-000001'));
check('版本面板每项带回退按钮', findAll(chapterTree, 'button', '回退').length === 1);

/* 点「台账」应列出本章运行记录 */
fetchScript = Array.from({ length: 30 }, () => ({
  runs: [{ run_id: 'run-x', chapters: [{ order: 1, status: 'committed', verdict: 'pass', attempts: 1, cjk_chars: 2798 }] }],
}));
await findAll(chapterTree, 'button', '台账')[0].props.onClick();
chapterTree = await settle(chapterElement);
check('台账列出本章运行记录', textOf(chapterTree).includes('run-x') && textOf(chapterTree).includes('committed'));

/* --- 13. 指纹报告展示：字段名对齐 ndecon ---------------------------------- */

const lintSample = {
  version: 'fp-v1', cjk_chars: 2798, paragraph_count: 42, passed: false,
  findings: [
    { rule: 'dash', label: '破折号', value: 3, limit: 1, severity: 'warn', passed: false, detail: '第 2 段' },
    { rule: 'cjk', label: '字数', value: 2798, limit: 2000, severity: 'info', passed: true, detail: '' },
  ],
};
const lintOutput = T.lintText(lintSample);
check('指纹报告先说是否通过', lintOutput.includes('有规则越界'));
check('指纹报告逐条列 label 与实测/阈值', lintOutput.includes('破折号') && lintOutput.includes('3 / 阈值 1'));
check('指纹报告标出越界项', lintOutput.includes('✗') && lintOutput.includes('✓'));
check('指纹报告 null 不抛', T.lintText(null) === '（无结果）');

/* --- 14. 台账展示只挑本章 ------------------------------------------------ */

const runsSample = { runs: [
  { run_id: 'run-a', chapters: [
    { order: 1, status: 'committed', verdict: 'pass', attempts: 1, cjk_chars: 2700 },
    { order: 2, status: 'rolled_back', verdict: 'repair', attempts: 3, cjk_chars: 2100,
      hard_failures: ['chapter_length'],
      hard_failure_details: ['偏短：实测 1209 字，目标 2600 字，允许 2210-2989'],
      error: '超过修复重试上限' },
  ] },
] };
const runsOut = T.runsText(runsSample, 2);
check('台账只列指定章', runsOut.includes('第 2 章') && !runsOut.includes('第 1 章'));
check('台账带上尝试次数与字数', runsOut.includes('尝试 3 次') && runsOut.includes('2100 字'));
check('台账带上硬门实测值（否则事后看不出差多少）', runsOut.includes('实测 1209 字'));
check('台账带上失败原因', runsOut.includes('超过修复重试上限'));
check('台账空时不抛', T.runsText(null, 1) === '本章还没有运行记录。');
check('台账没有明细时不硬编', T.runsText({ runs: [{ run_id: 'r', chapters: [{ order: 1, status: 'committed' }] }] }, 1).includes('第 1 章'));

// 摘要来源要显示：机械兜底只保证不断档，模型读过的才有情节级信息。
// 不显示的话，用户看到 10 章全 committed，不知道后面几章上下文其实很薄。
const runsModel = T.runsText({ runs: [{ run_id: 'r1', chapters: [
  { order: 1, status: 'committed', verdict: 'pass', summary_source: 'model' }] }] }, 1);
check('台账显示摘要由模型读过', runsModel.includes('摘要由模型读过'), runsModel);
const runsMech = T.runsText({ runs: [{ run_id: 'r1', chapters: [
  { order: 1, status: 'committed', verdict: 'pass', summary_source: 'mechanical' }] }] }, 1);
check('台账显示机械兜底摘要', runsMech.includes('机械兜底'), runsMech);
check('没有摘要来源时不硬编文案',
  !T.runsText({ runs: [{ run_id: 'r1', chapters: [
    { order: 1, status: 'committed', verdict: 'pass' }] }] }, 1).includes('摘要'));

/* --- 14b. 骨架失败的处置建议 ------------------------------------------- */

check('缺部件时建议重试或换模型',
  T.skeletonAdvice("骨架生成失败：创作骨架 JSON 不合法：缺少部件：protagonist（主角）").includes('换一个模型'));
check('超时建议调小章数',
  T.skeletonAdvice('骨架生成失败：模型响应超时（m，超过 60 秒）').includes('调小'));
check('未选模型建议先去模型页',
  T.skeletonAdvice('尚未选择模型供应商').includes('「模型」页'));
check('认不出的错误不硬编建议（避免瞎指路）',
  T.skeletonAdvice('HTTP 404') === '');
check('空消息不抛', T.skeletonAdvice(null) === '');

/* --- 14c. 连写失败的处置建议 ------------------------------------------- */

check('字数没过时指出是写得太短',
  T.runAdvice([{ order: 1, hard_failures: ['chapter_length'], error: '超过修复重试上限' }])
    .includes('写得太短'));
check('重复桥段时指出要改细纲',
  T.runAdvice([{ order: 2, hard_failures: ['cross_chapter_similarity'] }]).includes('细纲'));
check('超时错误单独识别',
  T.runAdvice([{ order: 1, hard_failures: [], error: '章节生成失败：模型响应超时（m，超过 900 秒）' }])
    .includes('重启引擎'));
check('超时建议不提 NOVEL_DECON_TIMEOUT（用户改不到那个环境变量）',
  !T.runAdvice([{ order: 1, error: '章节生成失败：模型响应超时（m，超过 900 秒）' }])
    .includes('NOVEL_DECON_TIMEOUT'));
check('未选模型时指向模型页',
  T.runAdvice([{ order: 1, error: '章节生成失败：尚未选择模型供应商' }]).includes('「模型」页'));
check('认不出的失败不硬编建议',
  T.runAdvice([{ order: 1, status: 'failed', error: '' }]) === '');
check('没有失败章时返回空串（不要把"全部成功"也说成有问题）',
  T.runAdvice([]) === '');
check('空参数不抛', T.runAdvice(null) === '');

/* --- 15. 设置页：改工作区并显示项目数 ------------------------------------ */

fetchScript = Array.from({ length: 30 }, () => ({
  workspace: 'D:\\myproject\\.ndecon-workspace', workspaceOverride: null, projectCount: 7,
}));
const settingsElement = h(T.SettingsScreen, { busy: false, onBack() {}, onSaved() {} });
let settingsTree = mount(settingsElement);
settingsTree = await settle(settingsElement);
check('设置页显示当前工作区', textOf(settingsTree).includes('.ndecon-workspace'));
check('设置页显示项目数（换目录能立刻判断改对没有）', textOf(settingsTree).includes('7 本'));
check('设置页有工作区输入框', findAll(settingsTree, 'input').length === 1);
check('设置页有保存按钮', findAll(settingsTree, 'button', '保存并重启引擎').length === 1);

/* --- 16. 项目页：连写区间与落库方式 -------------------------------------- */

const projectPayload = {
  meta: { id: 'p1', title: '连写书' },
  premise: '一句话前提',
  cursor: 3,
  confirmed_parts: { positioning: 'auto-accepted', protagonist: 'auto-accepted', golden_finger: 'auto-accepted', chapters: 'auto-accepted' },
  draft: {
    positioning: '定位文本',
    protagonist: { name: '陆沉' },
    golden_finger: { name: '视界', ability: '看见裂缝', cost_limitation: '用一次失一段记忆' },
    chapters: Array.from({ length: 30 }, (_, i) => ({ order: i + 1, title: `第${i + 1}章` })),
  },
  manuscripts: { ch1: { order: 1, status: 'auto-accepted', word_count: 2798, updated_at: '2026-11-01T23:19:11' } },
};
fetchScript = Array.from({ length: 30 }, () => projectPayload);
const homeElement = h(T.ProjectHome, { projectId: 'p1', busy: false, onBack() {}, onOpenChapter() {} });
let homeTree = mount(homeElement);
homeTree = await settle(homeElement);
check('项目页有连写卡片', textOf(homeTree).includes('连写'));
check('连写默认区间从游标之后开始', textOf(homeTree).includes('本次将写第 4–13 章'), textOf(homeTree).slice(0, 400));
check('连写有落库方式下拉', findAll(homeTree, 'select').length === 1);
check('连写按钮带区间', findAll(homeTree, 'button', '连写第 4–13 章').length === 1);
check('项目页显示细纲总数与游标', textOf(homeTree).includes('细纲 30 章') && textOf(homeTree).includes('第 3 章'));

/* --- 17. 项目页必须有返回入口（否则进去就出不来） ------------------------- */

check('项目页正常渲染时有返回项目列表按钮',
  findAll(homeTree, 'button', '返回项目列表').length === 1,
  textOf(homeTree).slice(0, 200));
{
  let called = 0;
  fetchScript = Array.from({ length: 40 }, () => projectPayload);
  const backElement = h(T.ProjectHome, { projectId: 'p1', busy: false, onBack: () => { called += 1; }, onOpenChapter() {} });
  // 必须先 mount 再 settle：effect 在 mount 里才跑，settle 末尾那次渲染才读得到新状态。
  mount(backElement);
  const backTree = await settle(backElement);
  const backBtn = findAll(backTree, 'button', '返回项目列表')[0];
  if (backBtn) backBtn.props.onClick();
  check('返回按钮真的调用 onBack', called === 1, String(called));
}

/* --- 18. 骨架为空时给「生成骨架」入口，不留死路 --------------------------- */

const emptySkeletonPayload = {
  meta: { id: 'p2', title: '空骨架书' },
  premise: '一句话前提',
  cursor: 0,
  confirmed_parts: {},
  draft: { positioning: null, volume: null, protagonist: null, golden_finger: null, chapters: [] },
  manuscripts: {},
};
fetchScript = Array.from({ length: 40 }, () => emptySkeletonPayload);
const emptyElement = h(T.ProjectHome, { projectId: 'p2', busy: false, onBack() {}, onOpenChapter() {} });
let emptyTree = mount(emptyElement);
emptyTree = await settle(emptyElement);
check('骨架为空时显示「还没有骨架」提示', textOf(emptyTree).includes('还没有骨架'));
check('骨架为空时给出「生成骨架」按钮', findAll(emptyTree, 'button', '生成骨架').length === 1);
check('骨架为空时有章数输入框', findAll(emptyTree, 'input').length >= 1);
check('骨架为空时仍能返回项目列表', findAll(emptyTree, 'button', '返回项目列表').length === 1);

/* 有骨架时不该再显示补骨架卡片（避免用户误点覆盖已有细纲） */
check('有骨架时不显示「还没有骨架」', !textOf(homeTree).includes('还没有骨架'));

/* --- 19. 422 业务失败要带出逐条原因，不能只显示 HTTP 码 ------------------- */

{
  // 模拟 accept-skeleton 返回 422 + rejected：request() 要把 payload 挂到 error 上。
  // 按「方法 + 路径」分派，不要数调用次数——harness 每次 mount 都会重跑 effect，
  // load() 会多次打 GET，按次数分派必然错位（本轮实测踩过）。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const path = String(url && url.pathname ? url.pathname : url);
    if (method === 'POST' && path.includes('/generate')) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ meta: { id: 'p2' } }); } };
    }
    if (method === 'POST' && path.includes('/accept-skeleton')) {
      return {
        ok: false,
        status: 422,
        async text() {
          return JSON.stringify({
            accepted: ['positioning'],
            rejected: [{ part: 'golden_finger', reason: '金手指没有限制与代价（会写成无敌流）' }],
            confirmed_parts: { positioning: 'auto-accepted' },
          });
        },
      };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify(emptySkeletonPayload); } };
  };
  const el = h(T.ProjectHome, { projectId: 'p2', busy: false, onBack() {}, onOpenChapter() {} });
  mount(el);
  const tree = await settle(el);
  const genBtn = findAll(tree, 'button', '生成骨架')[0];
  check('422 用例：找得到「生成骨架」按钮', !!genBtn);
  if (genBtn) await genBtn.props.onClick();
  const after = await settle(el);
  check('422 时界面列出逐条原因而不是只报 HTTP 码',
    textOf(after).includes('金手指没有限制与代价'),
    textOf(after).slice(0, 400));
  check('422 时说明有几个部件入库', textOf(after).includes('1 个部件入库'), textOf(after).slice(0, 300));
  globalThis.fetch = originalFetch;
}

/* --- 20. 骨架部件可展开编辑并保存 ---------------------------------------- */

check('partFieldValues 按部件模型字段摊开',
  T.partFieldValues('golden_finger', { name: '视界', ability: '看见裂缝' })
    .map((f) => f.key).join(',') === 'name,form,ability,cost_limitation,growth_path');
check('partFieldValues 缺字段给空串而不是 undefined',
  T.partFieldValues('protagonist', { name: '陆沉' }).every((f) => typeof f.text === 'string'));
check('partFieldValues 列表字段用换行拼',
  T.partFieldValues('positioning', { selling_points: ['甲', '乙'] })[3].text === '甲\n乙');
check('partFromEdits 列表字段按行拆并丢空行',
  JSON.stringify(T.partFromEdits('positioning', { genre: '都市', selling_points: '甲\n\n乙\n ' }).selling_points)
    === '["甲","乙"]');
check('partFromEdits 文本字段 trim',
  T.partFromEdits('golden_finger', { ability: '  看见裂缝  ' }).ability === '看见裂缝');

{
  // 直接渲染 PartRow：本 harness 按元素对象身份给 hook 分键，而 ProjectHome 每次
  // 渲染都会新建 PartRow 元素，子组件内部状态会被重置。测子组件就单独挂它。
  fetchScript = Array.from({ length: 40 }, () => projectPayload);
  const rowEl = h(T.PartRow, { project: projectPayload, part: 'golden_finger', busy: false, onSaved() {} });
  mount(rowEl);
  let rowTree = await settle(rowEl);
  check('部件行折叠时显示名称摘要', textOf(rowTree).includes('视界'));
  check('部件行折叠时显示状态', textOf(rowTree).includes('已自动验收'));
  check('部件行折叠时没有输入框', findAll(rowTree, 'input').length === 0,
    String(findAll(rowTree, 'input').length));

  const kv = findAll(rowTree, 'div', '视界').find((node) => node.props && node.props.onClick);
  check('部件行可点击展开', !!kv);
  if (kv) {
    kv.props.onClick();
    rowTree = await settle(rowEl);
    check('展开后出现 5 个字段输入框', findAll(rowTree, 'input').length === 5,
      String(findAll(rowTree, 'input').length));
    check('展开后有「保存并确认」按钮', findAll(rowTree, 'button', '保存并确认').length === 1);
    check('展开后能看到「限制与代价」标签', textOf(rowTree).includes('限制与代价'));
    // 输入框的值是 props.value，不是文本节点，textOf 看不到——要直接读 props。
    check('展开后能力字段预填了当前值',
      findAll(rowTree, 'input').map((node) => node.props.value).includes('看见裂缝'),
      JSON.stringify(findAll(rowTree, 'input').map((node) => node.props.value)));
    check('展开后字段值已预填（不是空框）',
      findAll(rowTree, 'input').every((node) => typeof node.props.value === 'string'),
      JSON.stringify(findAll(rowTree, 'input').map((n) => n.props.value)));
  }
}

{
  // 保存：PUT parts/golden_finger 应带上编辑后的值
  const originalFetch = globalThis.fetch;
  let putBody = null;
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const path = String(url && url.pathname ? url.pathname : url);
    if (method === 'PUT' && path.includes('/parts/golden_finger')) {
      putBody = JSON.parse(init.body);
      return { ok: true, status: 200, async text() { return JSON.stringify(projectPayload); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify(projectPayload); } };
  };
  const rowEl = h(T.PartRow, { project: projectPayload, part: 'golden_finger', busy: false, onSaved() {} });
  mount(rowEl);
  let rowTree = await settle(rowEl);
  const kv = findAll(rowTree, 'div', '视界').find((node) => node.props && node.props.onClick);
  if (kv) {
    kv.props.onClick();
    rowTree = await settle(rowEl);
    const inputs = findAll(rowTree, 'input');
    // 第 3 个输入框对应 ability（name/form/ability/cost_limitation/growth_path）
    const abilityInput = inputs[2];
    if (abilityInput) {
      abilityInput.props.onChange({ target: { value: '改过的能力描述' } });
      rowTree = await settle(rowEl);
      const saveBtn = findAll(rowTree, 'button', '保存并确认')[0];
      if (saveBtn) await saveBtn.props.onClick();
      check('保存发出 PUT 且带上编辑后的值',
        !!putBody && putBody.content && putBody.content.ability === '改过的能力描述',
        JSON.stringify(putBody));
      check('保存后提示已标为人工确认', textOf(await settle(rowEl)).includes('已人工确认'));
    }
  }
  globalThis.fetch = originalFetch;
}

/* --- 20. 返回按钮：每一屏、每一种状态都要有 ------------------------------ */
// 用户报的原话：「所有页面都要添加返回按钮 返回上一步面板」。
// 以前只有正常渲染路径带返回，加载中/出错态什么都没有——点进一个加载失败的
// 章节页就卡死，只能关掉整个右栏标签。所以这里逐个状态都要断言。

{
  // BackBar 本体
  let back = 0;
  const bar = mount(h(T.BackBar, { label: '← 返回章节', onBack: () => { back += 1; } }));
  check('BackBar 渲染出给定文案', textOf(bar).includes('返回章节'), textOf(bar));
  const barBtn = findAll(bar, 'button', '返回章节')[0];
  check('BackBar 有可点按钮', !!barBtn);
  if (barBtn) barBtn.props.onClick();
  check('BackBar 点击真的调用 onBack', back === 1, String(back));

  // ProjectHome：加载中态（数据还没到）
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify(projectPayload); } });
  const loadingEl = h(T.ProjectHome, { projectId: 'p1', busy: false, onBack() {}, onOpenChapter() {} });
  const loadingTree = mount(loadingEl); // 只 mount 不 settle = 数据未到的第一帧
  check('项目页加载中态也有返回按钮',
    findAll(loadingTree, 'button', '返回项目列表').length === 1,
    textOf(loadingTree).slice(0, 200));

  // ProjectHome：出错态
  globalThis.fetch = async () => { throw new Error('引擎挂了'); };
  const errEl = h(T.ProjectHome, { projectId: 'p1', busy: false, onBack() {}, onOpenChapter() {} });
  mount(errEl);
  const errTree = await settle(errEl);
  check('项目页出错态也有返回按钮',
    findAll(errTree, 'button', '返回项目列表').length === 1,
    textOf(errTree).slice(0, 200));
  check('项目页出错态把原因显示出来', textOf(errTree).includes('引擎挂了'), textOf(errTree).slice(0, 200));

  // ChapterView：加载中态与出错态
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ record: null, content: null }); } });
  const chLoadingEl = h(T.ChapterView, { projectId: 'p1', order: 1, busy: false, onBack() {} });
  const chLoadingTree = mount(chLoadingEl);
  check('章节页加载中态也有返回按钮',
    findAll(chLoadingTree, 'button', '返回项目').length === 1,
    textOf(chLoadingTree).slice(0, 200));

  globalThis.fetch = async () => { throw new Error('读不到正文'); };
  const chErrEl = h(T.ChapterView, { projectId: 'p1', order: 1, busy: false, onBack() {} });
  mount(chErrEl);
  const chErrTree = await settle(chErrEl);
  check('章节页出错态也有返回按钮',
    findAll(chErrTree, 'button', '返回项目').length === 1,
    textOf(chErrTree).slice(0, 200));

  // ContextPackView：加载中态与出错态
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({}); } });
  const packLoadingEl = h(T.ContextPackView, { projectId: 'p1', order: 1, onClose() {} });
  const packLoadingTree = mount(packLoadingEl);
  check('上下文包加载中态也有返回按钮',
    findAll(packLoadingTree, 'button', '返回章节').length === 1,
    textOf(packLoadingTree).slice(0, 200));

  globalThis.fetch = async () => { throw new Error('上下文包 404'); };
  const packErrEl = h(T.ContextPackView, { projectId: 'p1', order: 1, onClose() {} });
  mount(packErrEl);
  const packErrTree = await settle(packErrEl);
  check('上下文包出错态也有返回按钮',
    findAll(packErrTree, 'button', '返回章节').length === 1,
    textOf(packErrTree).slice(0, 200));

  // ModelScreen / SettingsScreen：出错态
  globalThis.fetch = async () => { throw new Error('_models 挂了'); };
  const modelErrEl = h(T.ModelScreen, { busy: false, onBack() {} });
  mount(modelErrEl);
  const modelErrTree = await settle(modelErrEl);
  check('模型页出错态也有返回按钮',
    findAll(modelErrTree, 'button', '返回项目列表').length === 1,
    textOf(modelErrTree).slice(0, 200));

  globalThis.fetch = async () => { throw new Error('_settings 挂了'); };
  const setErrEl = h(T.SettingsScreen, { busy: false, onBack() {}, onSaved() {} });
  mount(setErrEl);
  const setErrTree = await settle(setErrEl);
  check('设置页出错态也有返回按钮',
    findAll(setErrTree, 'button', '返回项目列表').length === 1,
    textOf(setErrTree).slice(0, 200));

  // 项目页也要能删：进了项目发现是废稿，不该被迫先退回列表再找
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify(projectPayload); } });
  const homeDelEl = h(T.ProjectHome, { projectId: 'p1', busy: false, onBack() {}, onOpenChapter() {}, onDeleted() {} });
  mount(homeDelEl);
  const homeDelTree = await settle(homeDelEl);
  check('项目页有删除入口', findAll(homeDelTree, 'button', '删除这本书').length === 1,
    textOf(homeDelTree).slice(-200));
  check('项目页把删除放在「危险操作」区', textOf(homeDelTree).includes('危险操作'),
    textOf(homeDelTree).slice(-300));
  check('项目页删除同样写明不可撤销', textOf(homeDelTree).includes('没有回收站'));

  globalThis.fetch = originalFetch;
}

/* --- 21. 删除项目：两次确认，真的发 DELETE -------------------------------- */

{
  const originalFetch = globalThis.fetch;
  let deleted = [];
  let calls = [];
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const path = String(url && url.pathname ? url.pathname : url);
    calls.push(`${method} ${path}`);
    if (method === 'DELETE') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ deleted: 'p1' }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({}); } };
  };

  const delEl = h(T.DeleteProjectButton, {
    projectId: 'p1',
    title: '连写书',
    busy: false,
    onDeleted: (id) => deleted.push(id),
  });
  let delTree = mount(delEl);
  check('删除按钮初始文案是「删除这本书」',
    findAll(delTree, 'button', '删除这本书').length === 1,
    textOf(delTree));
  check('删除按钮写明不可撤销',
    textOf(delTree).includes('没有回收站'),
    textOf(delTree).slice(0, 200));

  // 第一次点：只进入待确认，绝不能发请求
  const armBtn = findAll(delTree, 'button', '删除这本书')[0];
  if (armBtn) armBtn.props.onClick();
  delTree = await settle(delEl);
  check('第一次点变成待确认文案',
    findAll(delTree, 'button', '确定删除').length === 1,
    textOf(delTree).slice(0, 200));
  check('第一次点不发 DELETE 请求',
    calls.filter((item) => item.startsWith('DELETE')).length === 0,
    JSON.stringify(calls));

  // 待确认态可以取消
  const cancelBtn = findAll(delTree, 'button', '取消')[0];
  check('待确认态给出取消按钮', !!cancelBtn);
  if (cancelBtn) cancelBtn.props.onClick();
  delTree = await settle(delEl);
  check('取消后回到「删除这本书」',
    findAll(delTree, 'button', '删除这本书').length === 1,
    textOf(delTree).slice(0, 200));

  // 两次点击才真删
  const armAgain = findAll(delTree, 'button', '删除这本书')[0];
  if (armAgain) armAgain.props.onClick();
  delTree = await settle(delEl);
  const fireBtn = findAll(delTree, 'button', '确定删除')[0];
  if (fireBtn) await fireBtn.props.onClick();
  delTree = await settle(delEl);
  check('第二次点真的发出 DELETE 请求',
    calls.some((item) => item.startsWith('DELETE') && item.includes('projects/p1')),
    JSON.stringify(calls));
  check('删除成功后回调收到项目 id',
    deleted.length === 1 && deleted[0] === 'p1',
    JSON.stringify(deleted));
}

{
  // 项目列表里点删除不能顺带把用户带进那个项目
  const originalFetch = globalThis.fetch;
  let picked = [];
  let deletedIds = [];
  const listPayload = [
    { meta: { id: 'p1', title: '连写书' }, kind: 'creation', chapter_count: 30, written: 1 },
  ];
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    if (method === 'DELETE') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ deleted: 'p1' }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify(listPayload); } };
  };
  const listEl = h(T.ProjectList, {
    busy: false,
    refreshKey: 0,
    onPick: (id) => picked.push(id),
    onCreated() {},
    onDeleted: (id) => deletedIds.push(id),
  });
  mount(listEl);
  let listTree = await settle(listEl);
  check('项目列表每行有删除按钮',
    findAll(listTree, 'button', '删除这本书').length === 1,
    textOf(listTree).slice(0, 300));

  // 点删除按钮外层包装必须 stopPropagation，否则会先触发进入项目
  const wrapper = findAll(listTree, 'div').find(
    (node) => node.props && typeof node.props.onClick === 'function'
      && JSON.stringify(node.props.onClick.toString()).includes('stopPropagation'),
  );
  check('删除按钮外层有 stopPropagation 包装', !!wrapper);
  if (wrapper) {
    let stopped = false;
    wrapper.props.onClick({ stopPropagation() { stopped = true; } });
    check('点删除时阻止了冒泡（不会顺带进入项目）', stopped === true);
    check('点删除时没有触发 onPick', picked.length === 0, JSON.stringify(picked));
  }
  globalThis.fetch = originalFetch;
}

console.log(`\n通过 ${passed.length} 项：`);
for (const name of passed) console.log(`  [ok] ${name}`);
if (failed.length > 0) {
  console.log(`\n失败 ${failed.length} 项：`);
  for (const name of failed) console.log(`  [FAIL] ${name}`);
}
process.exit(failed.length === 0 ? 0 : 1);
