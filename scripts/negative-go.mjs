/**
 * Go / A′ 单测层拆线负例：把 local.process.v1 的 languages 声明摘空。
 * 期望精确红「接线 + 路由 + 档位推导」那一组，其余单测保持绿；finally 无条件恢复。
 *
 * 与 negative*.mjs 同构：解析 vitest JSON reporter，押红 id 集合 + 相对通过数，
 * 不解析带 ANSI 的终端输出。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'server', 'local.ts');
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const report = join(root, '.negative-go-report.json');

const NEEDLE = "    languages: ['go', 'php', 'perl', 'r', 'ruby'],";
const BROKEN = '    languages: [],';

/** 只押这三条：languages 摘空后，接线声明、档位推导、经 execute 的路由都会红。 */
const EXPECTED_RED = [
  '登记为 server，如实声明 process-only / advisory',
  '★ 接缝：A′ 是 server 但 advisory，绝不因 target 被误判为可判分',
  '★ 连线层：经 execute() 后服务端 stdout 真的能读回字节',
].sort();

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[Go 负例] 源文件里找不到 languages 接线声明，判据已漂移，请先人工核对');
  process.exitCode = 2;
} else if (!existsSync(vitestBin)) {
  console.error('[Go 负例] 缺少 vitest，请先 npm install');
  process.exitCode = 2;
} else {
  let verdict = 1;
  let raw = '';
  try {
    writeFileSync(target, original.replace(NEEDLE, BROKEN));
    if (existsSync(report)) unlinkSync(report);

    const child = spawnSync(
      process.execPath,
      [vitestBin, 'run', 'src/tests/capabilities.test.ts', 'src/tests/local.test.ts',
        '--reporter=json', `--outputFile=${report}`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
    );
    raw = `${child.stdout || ''}${child.stderr || ''}`;

    if (!existsSync(report)) {
      console.error('[Go 负例] 没有生成 JSON 报告，原始输出：\n' + raw.slice(-2000));
    } else {
      const data = JSON.parse(readFileSync(report, 'utf8'));
      const redIds = (data.testResults || [])
        .flatMap((suite) => suite.assertionResults || [])
        .filter((a) => a.status === 'failed')
        .map((a) => a.title)
        .sort();
      const exact =
        JSON.stringify(redIds) === JSON.stringify(EXPECTED_RED) &&
        data.numFailedTests === EXPECTED_RED.length &&
        data.numPassedTests === data.numTotalTests - EXPECTED_RED.length;

      console.log(`[Go 负例] 改坏接线后：失败 ${data.numFailedTests} 条 / 通过 ${data.numPassedTests} 条 / 共 ${data.numTotalTests} 条`);
      console.log(`[Go 负例] 实际红：${redIds.join(' | ') || '无'}`);
      console.log(`[Go 负例] 预期红：${EXPECTED_RED.join(' | ')}`);
      if (!exact) {
        console.error('[Go 负例] 红的集合或计数与预期不符；红得少 = 判据没押在接线层，红得多 = 改坏了别的对象');
        console.error('[Go 负例] 保留的原始输出尾部：\n' + raw.slice(-1200));
      } else {
        console.log(`[Go 负例] 通过：${EXPECTED_RED.length} 条精确红，其余 ${data.numPassedTests} 条未漂移`);
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[Go 负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(report)) unlinkSync(report);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[Go 负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[Go 负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
