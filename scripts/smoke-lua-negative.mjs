/**
 * Lua 浏览器层拆线负例：把 Lua Worker 里 __pg_out 的 stdout 回传掐断，
 * 期望「依赖 stdout 的 8 条 Lua 判据」精确红，其余 29 条全绿、2 条记账跳过不动。
 *
 * 判据不靠数汇总数字：直接读 ?selftest=1 落盘的完整 JSON，比对红的 id 集合。
 * 数字可以碰巧对，集合碰不了巧 —— 这是「判据的判据」。
 * finally 无条件恢复源文件。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'browser', 'lua-worker.ts');
const reportFile = join(root, '.smoke-lua-report.json');

const NEEDLE = "      send({ __pg: true, kind: 'out', stream: 'stdout', text: String(text) });";
const BROKEN = '      void String(text);';

/** 这些判据都押「print / io.write 的 stdout 真的能读回字节」。 */
const EXPECTED_RED = [
  'lua/io-read-number',
  'lua/io-write',
  'lua/multi-file',
  'lua/stdin',
  'lua/stdout',
  'lua/table',
  'lua/utf8',
  'lua/version',
].sort();

const EXPECTED_SKIPS = ['css/infinite-loop', 'html/infinite-loop'].sort();

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[Lua 真机负例] 找不到 stdout 回传语句，判据已漂移');
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
        PLAYGROUND_PORT: '5190',
        PLAYGROUND_CDP_PORT: '9335',
        PLAYGROUND_REPORT_FILE: reportFile,
      },
      timeout: 300000,
    });
    const raw = `${child.stdout || ''}${child.stderr || ''}`;
    console.log(raw.trim());

    if (!existsSync(reportFile)) {
      console.error('[Lua 真机负例] 没有落盘自检报告，判据没跑起来');
    } else {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const redIds = report.assertions
        .filter((a) => a.status === 'fail')
        .map((a) => a.id)
        .sort();
      const skips = [...(report.skipIds || [])].sort();
      const exact =
        JSON.stringify(redIds) === JSON.stringify(EXPECTED_RED) &&
        report.passed === 29 &&
        report.failed === 8 &&
        report.skipped === 2 &&
        JSON.stringify(skips) === JSON.stringify(EXPECTED_SKIPS);

      console.log(`[Lua 真机负例] 实际红 ${redIds.length} 条：${redIds.join(', ') || '无'}`);
      console.log(`[Lua 真机负例] 预期红 ${EXPECTED_RED.length} 条：${EXPECTED_RED.join(', ')}`);
      if (!exact) {
        console.error('[Lua 真机负例] 红的集合或计数与预期不符：红得少 = 判据没押在 stdout 回传层；红得多 = 改坏了别的链');
        for (const a of report.assertions.filter((x) => x.status === 'fail')) {
          console.error(`  [FAIL] ${a.id} — ${a.detail}`);
        }
      } else {
        console.log('[Lua 真机负例] 通过：8 条 stdout 判据精确红，其余 29 绿 / 2 记账跳过未漂移');
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[Lua 真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(reportFile)) unlinkSync(reportFile);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[Lua 真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[Lua 真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
