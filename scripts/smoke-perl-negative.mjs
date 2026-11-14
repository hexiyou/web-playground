/**
 * Perl / A′ 真机层拆线负例：把 local.process.v1 声明的语言摘掉 perl（保留 go + php + r + ruby）。
 * 期望全局接线门控 + 全部 Perl 判据（含 Cygwin 语义四条）+ sample/perl 精确红，
 * Go / PHP / 浏览器语言判据全绿，2 条记账跳过不动。finally 无条件恢复源文件。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'server', 'local.ts');
const reportFile = join(root, '.smoke-perl-report.json');

const NEEDLE = "    languages: ['go', 'php', 'perl', 'r', 'ruby'],";
const BROKEN = "    languages: ['go', 'php', 'r', 'ruby'],";

const EXPECTED_RED = [
  'global/wiring',
  'perl/backtick',
  'perl/capability',
  'perl/crlf',
  'perl/cygwin-semantics',
  'perl/flavor',
  'perl/multi-file',
  'perl/output-limit',
  'perl/path-escape',
  'perl/socket',
  'perl/stderr',
  'perl/stdin',
  'perl/stdout',
  'perl/syntax-error',
  'perl/timeout',
  'perl/utf8',
  'perl/utf8-layer-trap',
  'perl/version',
  'perl/wiring',
  'sample/perl',
].sort();

const EXPECTED_SKIPS = ['css/infinite-loop', 'html/infinite-loop'].sort();

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[Perl 真机负例] 找不到 languages 接线声明，判据已漂移');
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
        PLAYGROUND_PORT: '5199',
        PLAYGROUND_CDP_PORT: '9344',
        PLAYGROUND_REPORT_FILE: reportFile,
      },
      timeout: 420000,
    });
    console.log(`${child.stdout || ''}${child.stderr || ''}`.trim());

    if (!existsSync(reportFile)) {
      console.error('[Perl 真机负例] 没有落盘自检报告，判据没跑起来');
    } else {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const redIds = report.assertions.filter((a) => a.status === 'fail').map((a) => a.id).sort();
      const skips = [...(report.skipIds || [])].sort();
      const exact =
        JSON.stringify(redIds) === JSON.stringify(EXPECTED_RED) &&
        report.failed === EXPECTED_RED.length &&
        JSON.stringify(skips) === JSON.stringify(EXPECTED_SKIPS) &&
        report.passed === report.assertions.length - EXPECTED_RED.length - EXPECTED_SKIPS.length;

      console.log(`[Perl 真机负例] 实际红 ${redIds.length} 条：${redIds.join(', ') || '无'}`);
      console.log(`[Perl 真机负例] 预期红 ${EXPECTED_RED.length} 条：${EXPECTED_RED.join(', ')}`);
      if (!exact) {
        console.error('[Perl 真机负例] 红的集合或计数与预期不符');
        for (const a of report.assertions.filter((x) => x.status === 'fail')) {
          console.error(`  [FAIL] ${a.id} — ${a.detail}`);
        }
      } else {
        console.log(`[Perl 真机负例] 通过：${EXPECTED_RED.length} 条精确红，其余 ${report.passed} 绿 / ${report.skipped} 记账跳过未漂移`);
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[Perl 真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(reportFile)) unlinkSync(reportFile);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[Perl 真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[Perl 真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
