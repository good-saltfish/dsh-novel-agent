/**
 * 回归测试：同一份 client.js 被执行两次时，不许把右栏拖死。
 *
 * 为什么需要这条：插件改名（dsh-novel-studio → dsh-novel-agent）之后，页面启动清单里
 * 还留着旧包名的 URL（有插件会把启动时的脚本清单冻结一份复用），新旧两个 URL 指向同
 * 一个文件。宿主的 __ModuleLoader__.register() 拿 id 当唯一键，第二次注册会抛
 *   client-modules: duplicate factory registration for "dsh-novel-agent"
 * 右栏整个半边加载失败——用户看到的就是「插件崩了」。
 *
 * 这里把宿主的判据照搬过来（同一 id 第二次就抛），然后**真的**把文件执行多遍：
 * ESM 的 import 带不同的 query 串会被当成不同模块各自执行，正好模拟「两个 URL」。
 *
 * 三条要同时成立，缺一条就说明修法错了：
 *   a) 重复执行不再抛，注册仍是 1 份；
 *   b) 第一次注册的 factory 仍可调用；
 *   c) 宿主 invalidate 之后的**合法重注册**必须放行 —— 如果靠「注册过就跳过」的标记
 *      来实现幂等，(c) 会被一起挡掉，宿主随后报 `loaded without registering`，
 *      右栏再也回不来。
 *
 * 跑法：node test/client-double-load.mjs
 */

const CLIENT = new URL('../lib/client.js', import.meta.url);

/* ------------------------------------------------------------------ */
/* 宿主的最小替身                                                       */
/* ------------------------------------------------------------------ */

const registrations = [];
const refused = [];

const loader = {
  load(spec) {
    // 照抄宿主的判据：id 已注册过就抛，文案与宿主一致。
    if (registrations.some((item) => item.id === spec.id)) {
      const error = new Error(
        `client-modules: duplicate factory registration for "${spec.id}" `
          + '(bundle executed twice without invalidate?)',
      );
      refused.push(error);
      throw error;
    }
    registrations.push(spec);
  },
  /** 宿主热重载的第一步：把旧 factory 丢掉，然后重新执行脚本来注册。 */
  invalidate(id) {
    for (let i = registrations.length - 1; i >= 0; i -= 1) {
      if (registrations[i].id === id) registrations.splice(i, 1);
    }
  },
};

globalThis.window = { __ModuleLoader__: loader };

// client.js 顶层就会碰这几个东西，缺了会在注册前后炸掉，测不到我们想测的分支。
const styleNodes = [];
globalThis.document = {
  baseURI: 'http://localhost/',
  head: { appendChild(node) { styleNodes.push(node); } },
  querySelector() { return null; },
  createElement(tag) { return { tag, dataset: {}, textContent: '' }; },
};
globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return '[]'; } });

const React = {
  createElement() { return null; },
  Fragment: 'Fragment',
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  useEffect() {},
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useRef(value) { return { current: value }; },
  createContext(defaultValue) { return { Provider: 'Provider', defaultValue }; },
  useContext(context) { return context && context.defaultValue; },
};

/* ------------------------------------------------------------------ */
/* 真执行                                                              */
/* ------------------------------------------------------------------ */

function fakeRequire(name) {
  if (name === 'react') return React;
  throw new Error(`未预期的 require：${name}`);
}

async function runOnce(tag) {
  await import(`${CLIENT.href}?run=${tag}`);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

await runOnce('first');
check('第一次执行注册了一次 factory', registrations.length === 1, `实际 ${registrations.length} 次`);

let duplicateThrew = false;
try {
  await runOnce('second');
} catch {
  duplicateThrew = true;
}
check('第二次执行没有再注册', registrations.length === 1, `实际 ${registrations.length} 次`);
check('第二次执行没有把异常抛给宿主', duplicateThrew === false, duplicateThrew ? '抛了' : '');
check('宿主确实拒绝了第二次注册（说明确实执行了两遍）', refused.length === 1, `拒绝 ${refused.length} 次`);
check('注册的 id 是新名字', registrations[0] && registrations[0].id === 'dsh-novel-agent',
  registrations[0] ? registrations[0].id : '无');
check('注册带 factory', !!(registrations[0] && typeof registrations[0].factory === 'function'), '');

let exportsOk = false;
let exportsDetail = '';
try {
  const built = registrations[0].factory(fakeRequire);
  exportsOk = !!built && typeof built === 'object';
  exportsDetail = built ? Object.keys(built).slice(0, 6).join(',') : 'factory 返回空';
} catch (error) {
  exportsDetail = String((error && error.message) || error);
}
check('第一次注册的 factory 仍然可用', exportsOk, exportsDetail);

// (c) 宿主热重载：invalidate 之后重新执行，必须重新注册成功。
loader.invalidate('dsh-novel-agent');
const beforeReRegister = registrations.length;
let reRegisterThrew = false;
try {
  await runOnce('after-invalidate');
} catch {
  reRegisterThrew = true;
}
check('invalidate 之后清空了旧 factory', beforeReRegister === 0, `剩 ${beforeReRegister} 份`);
check('合法重注册放行', reRegisterThrew === false && registrations.length === 1,
  reRegisterThrew ? '重注册被挡掉了' : `注册 ${registrations.length} 份`);

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

let failed = 0;
for (const item of results) {
  const mark = item.ok ? '通过' : '失败';
  if (!item.ok) failed += 1;
  const tail = item.detail ? `（${item.detail}）` : '';
  console.log(`${mark}：${item.name}${tail}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
