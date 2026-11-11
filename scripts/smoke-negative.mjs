/**
 * 浏览器层拆线负例：把 iframe bridge 的消息回传从 parent.postMessage 改成 self.postMessage，
 * 预览页的输出/快照/done 就到不了主页面。期望 iframe 链的 10 条判据精确红，
 * Worker 链与全局判据全绿 —— 证明 ?selftest=1 不是「怎么改都全绿」的假判据。
 *
 * 判据不靠数汇总数字：直接读落盘的完整 JSON，比对红的 id 集合；通过数押
 * 「总数 - 红数 - 跳过数」的相对关系，新增语言时这条负例不会跟着漂移。
 * finally 无条件恢复源文件。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'browser', 'iframe.ts');
const reportFile = join(root, '.smoke-negative-report.json');
const NEEDLE = 'parent.postMessage(Object.assign(';
const BROKEN = 'self.postMessage(Object.assign(';

/** 这 10 条都押「iframe 里的可观察副作用真的能回传」。 */
const EXPECTED_RED = [
  'css/cascade',
  'css/computed',
  'css/custom-skeleton',
  'css/style-escape',
  'css/utf8',
  'html/console',
  'html/inline-css',
  'html/page-text',
  'html/script-error',
  'html/utf8',
].sort();

const EXPECTED_SKIPS = ['css/infinite-loop', 'html/infinite-loop'].sort();

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[真机负例] 找不到 bridge 回传语句，判据已漂移');
  process.exitCode = 2;
} else {
  let verdict = 1;
  try {
    writeFileSync(target, original.replace(NEEDLE, BROKEN));
    if (existsSync(reportFile)) unlinkSync(reportFile);
    const child = spawnSync(process.execPath, [join(root, 'scripts', 'smoke.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        PLAYGROUND_PORT: '5189',
        PLAYGROUND_CDP_PORT: '9334',
        PLAYGROUND_REPORT_FILE: reportFile,
      },
      timeout: 300000,
    });
    const raw = `${child.stdout || ''}${child.stderr || ''}`;
    console.log(raw.trim());

    if (!existsSync(reportFile)) {
      console.error('[真机负例] 没有落盘自检报告，判据没跑起来');
    } else {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const redIds = report.assertions
        .filter((a) => a.status === 'fail')
        .map((a) => a.id)
        .sort();
      const skips = [...(report.skipIds || [])].sort();
      const exact =
        JSON.stringify(redIds) === JSON.stringify(EXPECTED_RED) &&
        report.failed === EXPECTED_RED.length &&
        report.skipped === EXPECTED_SKIPS.length &&
        JSON.stringify(skips) === JSON.stringify(EXPECTED_SKIPS) &&
        report.passed === report.assertions.length - EXPECTED_RED.length - EXPECTED_SKIPS.length;

      console.log(`[真机负例] 实际红 ${redIds.length} 条：${redIds.join(', ') || '无'}`);
      console.log(`[真机负例] 预期红 ${EXPECTED_RED.length} 条：${EXPECTED_RED.join(', ')}`);
      if (!exact) {
        console.error('[真机负例] 红的集合或计数与预期不符：红得少 = 判据没押在消息回传层；红得多 = 改坏了别的链');
        for (const a of report.assertions.filter((x) => x.status === 'fail')) {
          console.error(`  [FAIL] ${a.id} — ${a.detail}`);
        }
      } else {
        console.log(`[真机负例] 通过：iframe 链 ${EXPECTED_RED.length} 条精确红，其余 ${report.passed} 绿 / ${report.skipped} 记账跳过未漂移`);
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(reportFile)) unlinkSync(reportFile);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
