/**
 * 浏览器层拆线负例：把 iframe bridge 的消息回传从 parent.postMessage 改成 self.postMessage，
 * 预览页的输出/快照/done 就到不了主页面。期望 iframe 链的 10 条判据精确红，
 * Worker 链与全局判据全绿 —— 证明 ?selftest=1 不是「怎么改都全绿」的假判据。
 * finally 无条件恢复源文件。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'browser', 'iframe.ts');
const NEEDLE = 'parent.postMessage(Object.assign(';
const BROKEN = 'self.postMessage(Object.assign(';

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[真机负例] 找不到 bridge 回传语句，判据已漂移');
  process.exitCode = 2;
} else {
  let verdict = 1;
  try {
    writeFileSync(target, original.replace(NEEDLE, BROKEN));
    const child = spawnSync(process.execPath, [join(root, 'scripts', 'smoke.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        PLAYGROUND_PORT: '5189',
        PLAYGROUND_CDP_PORT: '9334',
      },
      timeout: 240000,
    });
    const raw = `${child.stdout || ''}${child.stderr || ''}`;
    const summary = /\[真机自检\] 通过 (\d+) · 失败 (\d+) · 记账跳过 (\d+)/.exec(raw);
    console.log(raw.trim());

    if (!summary) {
      console.error('[真机负例] 没读到自检汇总，原始输出见上');
    } else {
      const [, passed, failed, skipped] = summary.map(Number);
      const exact = failed === 10 && passed === 14 && skipped === 2;
      if (exact) {
        console.log('[真机负例] 通过：iframe 链 10 条精确红，Worker 链与全局判据仍全绿，跳过记账未漂移');
        verdict = 0;
      } else {
        console.error(`[真机负例] 期望 通过 14 / 失败 10 / 跳过 2，实际 通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}`);
        console.error('[真机负例] 红得少 = 判据没押在消息回传层；红得多 = 改坏了 Worker 链');
      }
    }
  } catch (err) {
    console.error('[真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
