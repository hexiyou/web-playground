/**
 * A′ 节点层判据：手动配置运行时路径 + runtimes 动态探测。
 *
 * 真机自检（浏览器里跑）只能看到「PHP 能跑」，看不到「路径配置到底有没有生效」；
 * 这里直接打节点的 HTTP 接口，用四个场景把可观察副作用钉死：
 *   A 正常配置：php.path 指向便携式可执行文件 → runtimes.source=config、execute 真跑通
 *   B 坏路径：路径不存在 → php 从 runtimes 消失、execute 明确 400（自动置灰）
 *   C disabled：PATH 里明明有 php，但显式关闭优先 → 仍然不登记（「关」必须是第一句）
 *   D 空 path：回退 PATH → runtimes.source=path，且 Go 两阶段不回归
 *
 * 每个场景都重启节点（配置只在启动时读一次），临时配置文件与进程在 finally 清理。
 * 判据只押接口能看到的事实，不押日志文字。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIfNeeded } from './local-server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'servers', 'local');
const exe = join(dir, 'bin', process.platform === 'win32' ? 'playground-local.exe' : 'playground-local');
const PORT = Number(process.env.PLAYGROUND_NODE_CHECK_PORT || 2099);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'pg-local-dev-token';
const configPath = join(tmpdir(), `pg-runtimes-check-${process.pid}.json`);
const reportPath = join(root, '.node-check-report.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${id} — ${detail}`);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.timeout(8000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 也算一种可观察结果 */ }
  return { status: res.status, body };
}

async function alive() {
  try {
    const res = await fetch(`${BASE}/health`, {
      headers, signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let child = null;
async function stopNode() {
  if (!child) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([done, sleep(3000)]);
  child = null;
  for (let i = 0; i < 30; i++) {
    if (!(await alive())) return;
    await sleep(100);
  }
  throw new Error('节点进程未在 3 秒内释放端口');
}

async function startNode(config) {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  child = spawn(exe, ['-addr', `127.0.0.1:${PORT}`, '-token', TOKEN, '-config', configPath], {
    cwd: dir, stdio: 'ignore', windowsHide: true,
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  for (let i = 0; i < 60; i++) {
    if (await alive()) return;
    if (exited) throw new Error('节点启动后立即退出（检查 -config 或端口占用）');
    await sleep(150);
  }
  throw new Error('等待节点 /health 超时（9s）');
}

/** 一条最小 PHP 执行请求，用来证明配置出来的解释器真的能跑代码。 */
function phpExecute(code) {
  return api('/api/v2/execute', {
    method: 'POST',
    body: JSON.stringify({
      language: 'php', version: '*',
      files: [{ name: 'main.php', content: code }],
      stdin: '', args: [],
      compile_timeout: 10000, run_timeout: 5000, output_max_size: 65536,
    }),
  });
}

async function main() {
  buildIfNeeded();
  if (await alive()) {
    throw new Error(`${PORT} 端口已有节点在线，脚本不误杀别人的进程；请换 PLAYGROUND_NODE_CHECK_PORT`);
  }

  const probe = spawnSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout.trim()) {
    throw new Error('本机没有可用的 php 命令，无法验证配置路径；请先装 PHP 或在 PATH 里提供 php');
  }
  const phpExe = probe.stdout.trim();
  console.log(`[前置] 本机 PHP 可执行文件：${phpExe}`);
  check('node/php-executable', existsSync(phpExe), `PHP_BINARY 指向的文件存在=${existsSync(phpExe)}`);

  // ---------- A 正常配置路径 ----------
  await startNode({
    runtimes: { go: { path: '' }, php: { path: phpExe } },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    const go = list.find((x) => x.language === 'go');
    const php = list.find((x) => x.language === 'php');
    check('config/runtimes-go-path-fallback', rt.status === 200 && !!go && go.source === 'path' && !!go.version,
      `go=${JSON.stringify(go ?? null)}`);
    check('config/runtimes-php-source-config', rt.status === 200 && !!php && php.source === 'config' && !!php.version,
      `php=${JSON.stringify(php ?? null)}`);

    const health = await api('/health');
    check('config/health-reports-config', String(health.body?.config ?? '').includes('pg-runtimes-check') &&
      Object.keys(health.body?.missing ?? {}).length === 0,
      `config=${health.body?.config} missing=${JSON.stringify(health.body?.missing ?? {})}`);

    const run = await phpExecute('<?php echo "NODE-PHP-CONFIG-OK";');
    const stdout = run.body?.run?.stdout ?? '';
    const probes = run.body?.probes ?? {};
    check('config/execute-really-runs', run.status === 200 && stdout.includes('NODE-PHP-CONFIG-OK'),
      `status=${run.status} stdout=${stdout.slice(0, 100)}`);
    check('config/execute-probes-source', probes.runtimePathSource === 'config' && probes.stages === 'run',
      `runtimePathSource=${probes.runtimePathSource} stages=${probes.stages}`);

    // Go 不能因为加了一门语言而回归：两阶段、stdout 真回显。
    const goRun = await api('/api/v2/execute', {
      method: 'POST',
      body: JSON.stringify({
        language: 'go', version: '*',
        files: [{ name: 'main.go', content: 'package main\nimport "fmt"\nfunc main(){fmt.Println("NODE-GO-OK")}' }],
        stdin: '', args: [],
        compile_timeout: 10000, run_timeout: 5000, output_max_size: 65536,
      }),
    });
    check('config/go-not-regressed', goRun.status === 200 &&
      (goRun.body?.run?.stdout ?? '').includes('NODE-GO-OK') &&
      goRun.body?.probes?.stages === 'build+run',
      `status=${goRun.status} stdout=${(goRun.body?.run?.stdout ?? '').slice(0, 80)} stages=${goRun.body?.probes?.stages}`);
  }

  // ---------- B 坏路径 → 自动置灰 ----------
  await stopNode();
  await startNode({
    runtimes: { go: { path: '' }, php: { path: join(tmpdir(), 'pg-no-such-php.exe') } },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    check('badpath/php-not-registered', list.some((x) => x.language === 'go') &&
      !list.some((x) => x.language === 'php'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    const health = await api('/health');
    check('badpath/health-explains-why', typeof health.body?.missing?.php === 'string' &&
      /path/.test(health.body.missing.php),
      `missing.php=${health.body?.missing?.php ?? '无'}`);
    const run = await phpExecute('<?php echo 1;');
    check('badpath/execute-rejected', run.status === 400 &&
      /runtime is unknown/.test(run.body?.message ?? ''),
      `status=${run.status} message=${run.body?.message ?? ''}`);
  }

  // ---------- C disabled 优先于 PATH ----------
  await stopNode();
  await startNode({
    runtimes: { go: { path: '' }, php: { path: '', disabled: true } },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    check('disabled/php-hidden-despite-path', list.some((x) => x.language === 'go') &&
      !list.some((x) => x.language === 'php'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    const health = await api('/health');
    check('disabled/health-says-disabled', /disabled/.test(health.body?.missing?.php ?? ''),
      `missing.php=${health.body?.missing?.php ?? '无'}`);
  }

  // ---------- D 空 path 回退 PATH ----------
  await stopNode();
  await startNode({
    runtimes: { go: { path: '' }, php: { path: '' } },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    const php = list.find((x) => x.language === 'php');
    check('fallback/php-source-path', !!php && php.source === 'path' && !!php.version,
      `php=${JSON.stringify(php ?? null)}`);
    const run = await phpExecute('<?php echo "NODE-PHP-PATH-OK";');
    check('fallback/execute-really-runs', run.status === 200 &&
      (run.body?.run?.stdout ?? '').includes('NODE-PHP-PATH-OK') &&
      run.body?.probes?.runtimePathSource === 'path',
      `status=${run.status} stdout=${(run.body?.run?.stdout ?? '').slice(0, 80)} source=${run.body?.probes?.runtimePathSource}`);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  writeFileSync(reportPath, JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
  console.log(`\n[节点判据] 通过 ${passed} · 失败 ${failed} · 共 ${results.length} 条 · 报告 ${reportPath}`);
  if (failed > 0) {
    for (const r of results.filter((x) => !x.ok)) console.error(`  [FAIL] ${r.id} — ${r.detail}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('[节点判据] 执行异常：', err?.message || err);
  process.exitCode = 1;
} finally {
  await stopNode();
  if (existsSync(configPath)) unlinkSync(configPath);
  if (existsSync(reportPath)) {
    // 报告留档给排查用，但内容必须是本轮真跑的结果。
    try { JSON.parse(readFileSync(reportPath, 'utf8')); } catch { unlinkSync(reportPath); }
  }
  console.log('[节点判据] 临时配置与节点进程已清理');
}
