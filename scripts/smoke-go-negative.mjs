/**
 * 服务端真机层拆线负例：把 main.ts 里注入的本地执行节点 Runner 摘掉。
 * v0.6 起 A′ 同时承载 Go 与 PHP，所以这一刀会让**两门服务端语言一起红**；
 * 期望 Go / PHP 全部判据 + 全局接线门控精确红，其余浏览器语言判据全绿、
 * 2 条记账跳过不动。想只拆一门请用 smoke:negative:php。
 *
 * 这条负例专门治「单元判据对没接线天生免疫」：单测里注入的是自己造的 registry，
 * 只有真页面的 createRegistry 调用点被拆掉，才证明 UI 那一行真的连着服务端。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'main.ts');
const reportFile = join(root, '.smoke-go-report.json');

const NEEDLE = `const registry = createRegistry(() => previewEl, [
  createLocalRunner({ baseUrl: serverUrl, token: serverToken }),
]);`;
const BROKEN = `const registry = createRegistry(() => previewEl, []);
void createLocalRunner;`;

const EXPECTED_RED = [
  'global/wiring',
  'go/capability',
  'go/compile-error',
  'go/multi-file',
  'go/output-limit',
  'go/path-escape',
  'go/stdin',
  'go/stdout',
  'go/stderr',
  'go/stdlib-only',
  'go/timeout',
  'go/wiring',
  'sample/go',
  'php/capability',
  'php/multi-file',
  'php/output-limit',
  'php/path-escape',
  'php/syntax-error',
  'php/stdin',
  'php/stdout',
  'php/stderr',
  'php/timeout',
  'php/url-wrapper',
  'php/utf8',
  'php/version',
  'php/wiring',
  'sample/php',
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
  console.error('[Go 真机负例] 找不到 createRegistry 注入段，判据已漂移');
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
        PLAYGROUND_PORT: '5197',
        PLAYGROUND_CDP_PORT: '9342',
        PLAYGROUND_REPORT_FILE: reportFile,
      },
      timeout: 420000,
    });
    console.log(`${child.stdout || ''}${child.stderr || ''}`.trim());

    if (!existsSync(reportFile)) {
      console.error('[Go 真机负例] 没有落盘自检报告，判据没跑起来');
    } else {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const redIds = report.assertions.filter((a) => a.status === 'fail').map((a) => a.id).sort();
      const skips = [...(report.skipIds || [])].sort();
      const exact =
        JSON.stringify(redIds) === JSON.stringify(EXPECTED_RED) &&
        report.failed === EXPECTED_RED.length &&
        JSON.stringify(skips) === JSON.stringify(EXPECTED_SKIPS) &&
        report.passed === report.assertions.length - EXPECTED_RED.length - EXPECTED_SKIPS.length;

      console.log(`[Go 真机负例] 实际红 ${redIds.length} 条：${redIds.join(', ') || '无'}`);
      console.log(`[Go 真机负例] 预期红 ${EXPECTED_RED.length} 条：${EXPECTED_RED.join(', ')}`);
      if (!exact) {
        console.error('[Go 真机负例] 红的集合或计数与预期不符');
        for (const a of report.assertions.filter((x) => x.status === 'fail')) {
          console.error(`  [FAIL] ${a.id} — ${a.detail}`);
        }
      } else {
        console.log(`[Go 真机负例] 通过：${EXPECTED_RED.length} 条精确红，其余 ${report.passed} 绿 / ${report.skipped} 记账跳过未漂移`);
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[Go 真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(reportFile)) unlinkSync(reportFile);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[Go 真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[Go 真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
