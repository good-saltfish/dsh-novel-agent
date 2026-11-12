/**
 * 一次跑完所有插件测试。
 *
 * 十四个套件各自独立、互不依赖，任何一个失败都必须让整体失败——
 * 单跑绿、全跑红是最容易漏掉的状态（端口/工作区/设置被别的测试污染）。
 *
 * 跑法：node test/all.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['package-json', '打包自检：package.json 无 BOM、能直解析、物料与版本号一致'],
  ['hosttest', '宿主基础：python 探测、CLI、错误可读、panel 起停、并发幂等'],
  ['smoke', '代理与安全：栅栏、穿越、编码、非法 JSON、超大请求体'],
  ['bridge', '模型桥：token、补全、JSON 模式、推理档、失败原因'],
  ['import-md', '设定稿导入：提示词、剥 JSON、必填项拒收、越界截断、空结果报错'],
  ['model-e2e', '模型链路：引擎 → 桥 → 宿主 llm（假 llm 替身）'],
  ['ops-e2e', '面板可操作：新建/生成/连写/编辑/版本/回退/确认/台账/设置'],
  ['tools-e2e', '工具面：7 个 novel_* 工具的注册与真调用'],
  ['client-dom', '组件层：假 React + 假 fetch 下的交互与展示函数'],
  ['fix-verify', '三处真机问题：返回入口、补骨架、部件编辑、连写、回退'],
  ['llm-sync', '模型自愈：引擎 token 过期后自动重下发（复现 401）'],
  ['runtime', '引擎自举：探测/安装/代理绕过/权限降级/并发去重'],
  ['client-double-load', '改名遗留：同一份 client.js 执行两次也只注册一次'],
  ['verify_double_load_guard', '反向验证：拿掉幂等守卫后上一条必须失败'],
];

const results = [];
for (const [name, why] of SUITES) {
  const file = path.join(here, `${name}.mjs`);
  process.stdout.write(`\n=== ${name} —— ${why}\n`);
  const run = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  results.push([name, run.status === 0]);
}

console.log('\n---------------------------------------------');
let failed = 0;
for (const [name, passed] of results) {
  if (!passed) failed += 1;
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} 套件通过`);
process.exit(failed === 0 ? 0 : 1);
