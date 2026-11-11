/**
 * 默认示例拆线负例：把 SQL 示例里已加引号的列别名改回 SQLite 保留字，
 * 精确复现「用户打开页面点运行就报 near "nothing": syntax error」。
 *
 * 期望只红 sample/sql 一条 —— 证明 sample/* 判据押的是 SAMPLES 原文，
 * 而不是自检自己造的干净 SQL；其余语言判据、跳过记账都不许漂移。
 * finally 无条件恢复源文件。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'src', 'core', 'samples.ts');
const reportFile = join(root, '.smoke-sample-report.json');

const NEEDLE = `SELECT sqlite_version() AS sqlite, '中文标记' AS label, NULL AS "nothing";`;
const BROKEN = `SELECT sqlite_version() AS sqlite, '中文标记' AS label, NULL AS nothing;`;

const EXPECTED_RED = ['sample/sql'];
const EXPECTED_SKIPS = ['css/infinite-loop', 'html/infinite-loop'].sort();

const original = readFileSync(target, 'utf8');
if (!original.includes(NEEDLE)) {
  console.error('[示例真机负例] 找不到已修正的列别名，判据已漂移');
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
        PLAYGROUND_PORT: '5192',
        PLAYGROUND_CDP_PORT: '9337',
        PLAYGROUND_REPORT_FILE: reportFile,
      },
      timeout: 300000,
    });
    const raw = `${child.stdout || ''}${child.stderr || ''}`;
    console.log(raw.trim());

    if (!existsSync(reportFile)) {
      console.error('[示例真机负例] 没有落盘自检报告，判据没跑起来');
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

      console.log(`[示例真机负例] 实际红 ${redIds.length} 条：${redIds.join(', ') || '无'}`);
      for (const a of report.assertions.filter((x) => x.status === 'fail')) {
        console.log(`  [FAIL] ${a.id} — ${a.detail}`);
      }
      if (!exact) {
        console.error('[示例真机负例] 红的集合或计数与预期不符');
      } else {
        console.log(`[示例真机负例] 通过：默认示例写坏时精确红 sample/sql，其余 ${report.passed} 绿 / ${report.skipped} 记账跳过未漂移`);
        verdict = 0;
      }
    }
  } catch (err) {
    console.error('[示例真机负例] 执行异常：', err.message || err);
  } finally {
    writeFileSync(target, original);
    if (existsSync(reportFile)) unlinkSync(reportFile);
    if (readFileSync(target, 'utf8') !== original) {
      console.error('[示例真机负例] 严重：源文件恢复失败，请手工比对 git');
      verdict = 1;
    } else {
      console.log('[示例真机负例] 源文件已恢复');
    }
  }
  process.exitCode = verdict;
}
