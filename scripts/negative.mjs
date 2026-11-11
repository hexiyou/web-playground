/**
 * 拆线负例：把 CSS 从真实 iframe runner 的 languages 里摘掉，
 * 期望「首版接线真值」精确红 1 条，其余判据全绿；finally 无条件恢复源文件。
 *
 * 判据解析走 vitest 的 JSON reporter + 落盘报告，不解析终端彩色输出
 * （FORCE_COLOR=0 压不住 vitest 的 ANSI，正则会把路名读成带转义的内容）。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'runners', 'browser', 'iframe.ts');
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const report = join(root, '.negative-report.json');

const NEEDLE = "languages: ['html', 'css', 'javascript', 'typescript'],";
const BROKEN = "languages: ['html', 'javascript', 'typescript'],";

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[负例] 源文件里找不到接线声明，判据已漂移，请先人工核对');
  process.exitCode = 2;
} else if (!existsSync(vitestBin)) {
  console.error('[负例] 缺少 node_modules/vitest/vitest.mjs，请先 npm install');
  process.exitCode = 2;
} else {
  let verdict = 0;
  let raw = '';
  try {
    writeFileSync(target, original.replace(NEEDLE, BROKEN));
    if (existsSync(report)) unlinkSync(report);

    const child = spawnSync(
      process.execPath,
      [vitestBin, 'run', 'src/tests/capabilities.test.ts', '--reporter=json', `--outputFile=${report}`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
    );
    raw = `${child.stdout || ''}${child.stderr || ''}`;

    if (!existsSync(report)) {
      console.error('[负例] 没有生成 JSON 报告，原始输出：\n' + raw.slice(-2000));
      verdict = 1;
    } else {
      const data = JSON.parse(readFileSync(report, 'utf8'));
      const failedNames = (data.testResults || [])
        .flatMap((suite) => suite.assertionResults || [])
        .filter((a) => a.status === 'failed')
        .map((a) => a.fullName);
      const expected = failedNames.length === 1 && failedNames[0].includes('接线真值');
      const exact = data.numFailedTests === 1 && expected;

      console.log(`[负例] 改坏 CSS 接线后：失败 ${data.numFailedTests} 条 / 通过 ${data.numPassedTests} 条 / 共 ${data.numTotalTests} 条`);
      console.log(`[负例] 失败用例：${failedNames.join(' | ') || '无'}`);
      if (!exact) {
        console.error('[负例] 期望「只红 1 条，且正是首版接线真值」；红得少说明判据没押在接线层，红得多说明改坏了别的对象');
        console.error('[负例] 保留的原始输出尾部：\n' + raw.slice(-1500));
        verdict = 1;
      } else {
        console.log('[负例] 通过：只有该判据精确红，其余全绿');
      }
    }
  } catch (err) {
    console.error('[负例] 执行异常：', err);
    console.error('[负例] 原始输出尾部：\n' + raw.slice(-1500));
    verdict = 1;
  } finally {
    writeFileSync(target, original);
    if (existsSync(report)) unlinkSync(report);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
