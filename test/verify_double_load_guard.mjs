/**
 * 证明 client-double-load.mjs 真能抓到问题：把「吞掉重复注册」那行守卫改回「直接抛」，
 * 它必须失败。
 *
 * 不这么做的话，「9/9 通过」可能只证明测试没跑对，证明不了它防的是真 bug。
 *
 * 跑法：node test/verify_double_load_guard.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const source = path.join(repoRoot, 'lib', 'client.js');

const GUARD = 'if (!isDuplicateRegistration(error)) throw error;';
const BROKEN = 'throw error;'; // 等价于修这个 bug 之前的形态

const original = await fs.readFile(source, 'utf8');
if (!original.includes(GUARD)) {
  console.error('没找到守卫那一行，反向验证要更新');
  process.exit(1);
}

const brokenPath = path.join(repoRoot, 'lib', '__client_without_guard.mjs');
await fs.writeFile(brokenPath, original.replace(GUARD, BROKEN));

const sandbox = path.join(here, '__double_load_without_guard.mjs');
const testSource = await fs.readFile(path.join(here, 'client-double-load.mjs'), 'utf8');
await fs.writeFile(
  sandbox,
  testSource.replace("new URL('../lib/client.js', import.meta.url)", "new URL('../lib/__client_without_guard.mjs', import.meta.url)"),
);

let status = 0;
let output = '';
try {
  const result = spawnSync(process.execPath, [sandbox], { encoding: 'utf8' });
  status = result.status;
  output = `${result.stdout || ''}${result.stderr || ''}`;
} finally {
  await fs.rm(brokenPath, { force: true });
  await fs.rm(sandbox, { force: true });
}

// 两个条件都要成立：进程失败，且失败原因真的是「第二次注册被抛出来了」。
const failedAsExpected = status !== 0;
const caughtByGuardTest = /第二次执行没有再注册|第二次执行没有把异常抛给宿主/.test(output);

if (failedAsExpected && caughtByGuardTest) {
  console.log('通过：拿掉守卫后回归测试确实失败，说明它防的是真 bug');
  const lines = output.trim().split('\n').filter((line) => line.startsWith('失败'));
  for (const line of lines) console.log(`  ${line}`);
  process.exit(0);
}

console.error('没通过：守卫拿掉后测试仍然通过，这条回归测试是假的');
console.error(output);
process.exit(1);
