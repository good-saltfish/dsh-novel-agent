/**
 * 打包自检：`package.json` 必须是宿主能直接 `JSON.parse` 的纯 UTF-8。
 *
 * 跑法：node test/package-json.mjs
 *
 * 为什么值得单独一个套件：
 * 0.2.1 / 0.2.2 的 `package.json` 被写进了 UTF-8 BOM（`EF BB BF`），宿主读的时候直接
 * `Unexpected token '\uFEFF', "﻿{\n  "name"... is not valid JSON`，插件在列表里显示成
 * 「异常 / 包不可用」——**一行代码都没跑到**，而本地所有测试、`npm pack`、`npm publish`
 * 全绿。BOM 不是「多数解析器会宽容忽略」的东西：JSON 规范不允许文件以 BOM 开头，
 * Windows 上某些编辑器与 PowerShell 重定向保存会悄悄加上。
 *
 * 所以这里断言的是「宿主看到的样子」：原始字节不以 BOM 开头，且 `JSON.parse` 成功。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`  FAIL ${name}\n       ${error && error.message}`);
  }
}

const raw = await readFile(path.join(root, 'package.json'));
const text = raw.toString('utf8');

await test('package.json 不以 UTF-8 BOM 开头', () => {
  const first = [raw[0], raw[1], raw[2]];
  assert.notDeepEqual(first, [0xef, 0xbb, 0xbf], '文件带了 BOM，宿主 JSON.parse 会报 Unexpected token');
});

await test('package.json 能被宿主直接 JSON.parse', () => {
  // 故意用原始文本，不做 trim、不剥 BOM —— 宿主就是这么读的。
  const data = JSON.parse(text);
  assert.equal(typeof data.name, 'string');
});

await test('包名与版本号合乎发布要求', () => {
  const data = JSON.parse(text);
  assert.equal(data.name, 'dsh-novel-agent', '包名必须是改名后的 dsh-novel-agent');
  assert.match(data.version, /^\d+\.\d+\.\d+$/, '版本号要是纯 semver，别带 v 前缀');
  assert.equal(data.private, undefined, 'private:true 会让 npm publish 失败');
});

await test('物料齐全：README / LICENSE / CHANGELOG / SECURITY 都在 files 里', async () => {
  const data = JSON.parse(text);
  for (const name of ['README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md']) {
    assert.ok(data.files.includes(name), `${name} 不在 files 里，发出去的包里就没有它`);
    await readFile(path.join(root, name));
  }
});

await test('CHANGELOG 顶部版本与 package.json 一致', async () => {
  const data = JSON.parse(text);
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const top = changelog.match(/^##\s+(\d+\.\d+\.\d+)/m);
  assert.ok(top, 'CHANGELOG 里找不到形如 "## 1.2.3" 的版本标题');
  assert.equal(top[1], data.version, '发了新版本却没写 CHANGELOG，用户看不到改了什么');
});

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const item of failed) console.error(`  FAIL ${item.name}: ${item.error && item.error.message}`);
  process.exit(1);
}
