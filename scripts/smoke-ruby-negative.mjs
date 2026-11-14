/**
 * Ruby / A′ 真机层拆线负例：把 local.process.v1 声明的语言摘掉 ruby
 * （保留 go + php + perl + r）。期望全局接线门控 + 全部 18 条 Ruby 判据
 * （含原生入口、PATH 探测、CRLF 不归一化、宿主语义）+ sample/ruby 精确红，
 * 其余服务端 / 浏览器语言判据全绿，2 条记账跳过不动。finally 无条件恢复源文件。
 *
 * 这条例抓的是「PATH 里能发现的原生 PE 运行时是否真接在页面注入的那一行上」：
 * 节点侧 62 条判据全绿也证明不了前端接线，只有真页面跑一遍才看得见。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'server', 'local.ts');
const reportFile = join(root, '.smoke-ruby-report.json');

const NEEDLE = "    languages: ['go', 'php', 'perl', 'r', 'ruby'],";
const BROKEN = "    languages: ['go', 'php', 'perl', 'r'],";

const EXPECTED_RED = [
  'global/wiring',
  'ruby/capability',
  'ruby/crlf',
  'ruby/flavor',
  'ruby/host-semantics',
  'ruby/multi-file',
  'ruby/output-limit',
  'ruby/path-escape',
  'ruby/require-relative',
  'ruby/socket',
  'ruby/stderr',
  'ruby/stdin',
  'ruby/stdlib-json',
  'ruby/stdout',
  'ruby/syntax-error',
  'ruby/timeout',
  'ruby/utf8',
  'ruby/version',
  'ruby/wiring',
  'sample/ruby',
].sort();

const EXPECTED_SKIPS = ['css/infinite-loop', 'html/infinite-loop'].sort();

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[Ruby 真机负例] 找不到 languages 接线声明，判据已漂移');
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
        PLAYGROUND_PORT: '5201',
        PLAYGROUND_CDP_PORT: '9346',
        PLAYGROUND_REPORT_FILE: reportFile,
      },
      timeout: 420000,
    });
    console.log(`${child.stdout || ''}${child.stderr || ''}`.trim());

    if (!existsSync(reportFile)) {
      console.error('[Ruby 真机负例] 没有落盘自检报告，判据没跑起来');
    } else {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const redIds = report.assertions.filter((a) => a.status === 'fail').map((a) => a.id).sort();
      const skips = [...(report.skipIds || [])].sort();
      const exact =
        JSON.stringify(redIds) === JSON.stringify(EXPECTED_RED) &&
        report.failed === EXPECTED_RED.length &&
        JSON.stringify(skips) === JSON.stringify(EXPECTED_SKIPS) &&
        report.passed === report.assertions.length - EXPECTED_RED.length - EXPECTED_SKIPS.length;

      console.log(`[Ruby 真机负例] 实际红 ${redIds.length} 条：${redIds.join(', ') || '无'}`);
      console.log(`[Ruby 真机负例] 预期红 ${EXPECTED_RED.length} 条：${EXPECTED_RED.join(', ')}`);
      if (!exact) {
        console.error('[Ruby 真机负例] 红的集合或计数与预期不符');
        for (const a of report.assertions.filter((x) => x.status === 'fail')) {
          console.error(`  [FAIL] ${a.id} — ${a.detail}`);
        }
      } else {
        console.log(`[Ruby 真机负例] 通过：${EXPECTED_RED.length} 条精确红，其余 ${report.passed} 绿 / ${report.skipped} 记账跳过未漂移`);
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[Ruby 真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(reportFile)) unlinkSync(reportFile);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[Ruby 真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[Ruby 真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
