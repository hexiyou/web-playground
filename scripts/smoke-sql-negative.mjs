/**
 * SQL 浏览器层拆线负例：把 sql-worker 结果行的 pending.push 掐断，
 * flush() 就永远没有内容可回传。期望「依赖 stdout 的 7 条 SQL 判据」精确红，
 * 其余判据全绿、2 条记账跳过不动 —— 证明 SQL 判据押的是「能读回字节」，
 * 不是「运行没抛错」。sample/sql 押的是 status，结果行断了仍应绿。
 *
 * 判据直接读落盘的完整 JSON 比对红 id 集合；通过数押相对关系。
 * finally 无条件恢复源文件。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'browser', 'sql-worker.ts');
const reportFile = join(root, '.smoke-sql-report.json');

const NEEDLE = '    pending.push(text);';
const BROKEN = '    void text;';

/** 这 7 条都押「SELECT 的结果真的能读回字节」；status / probes 类判据不该受影响。 */
const EXPECTED_RED = [
  'sql/empty-result',
  'sql/multi-file',
  'sql/multi-statement',
  'sql/null-blob',
  'sql/rows-modified',
  'sql/utf8',
  'sql/version',
].sort();

const EXPECTED_SKIPS = ['css/infinite-loop', 'html/infinite-loop'].sort();

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[SQL 真机负例] 找不到结果行回传语句，判据已漂移');
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
        PLAYGROUND_PORT: '5191',
        PLAYGROUND_CDP_PORT: '9336',
        PLAYGROUND_REPORT_FILE: reportFile,
      },
      timeout: 300000,
    });
    const raw = `${child.stdout || ''}${child.stderr || ''}`;
    console.log(raw.trim());

    if (!existsSync(reportFile)) {
      console.error('[SQL 真机负例] 没有落盘自检报告，判据没跑起来');
    } else {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const redIds = report.assertions
        .filter((a) => a.status === 'fail')
        .map((a) => a.id)
        .sort();
      const skips = [...(report.skipIds || [])].sort();
      const exact =
        JSON.stringify(redIds) === JSON.stringify(EXPECTED_RED) &&
        report.passed === report.assertions.length - EXPECTED_RED.length - EXPECTED_SKIPS.length &&
        report.failed === EXPECTED_RED.length &&
        report.skipped === EXPECTED_SKIPS.length &&
        JSON.stringify(skips) === JSON.stringify(EXPECTED_SKIPS);

      console.log(`[SQL 真机负例] 实际红 ${redIds.length} 条：${redIds.join(', ') || '无'}`);
      console.log(`[SQL 真机负例] 预期红 ${EXPECTED_RED.length} 条：${EXPECTED_RED.join(', ')}`);
      if (!exact) {
        console.error('[SQL 真机负例] 红的集合或计数与预期不符：红得少 = 判据没押在结果回传层；红得多 = 改坏了别的链');
        for (const a of report.assertions.filter((x) => x.status === 'fail')) {
          console.error(`  [FAIL] ${a.id} — ${a.detail}`);
        }
      } else {
        console.log(`[SQL 真机负例] 通过：${EXPECTED_RED.length} 条 stdout 判据精确红，其余 ${report.passed} 绿 / ${report.skipped} 记账跳过未漂移`);
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[SQL 真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(reportFile)) unlinkSync(reportFile);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[SQL 真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[SQL 真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
