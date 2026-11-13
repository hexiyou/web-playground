/**
 * A′ 节点层判据：手动配置运行时路径 + runtimes 动态探测 + 宿主风味。
 *
 * 真机自检（浏览器里跑）只能看到「PHP / Perl 能跑」，看不到「路径配置到底有没有生效」；
 * 这里直接打节点的 HTTP 接口，用四个场景把可观察副作用钉死：
 *   A 正常配置：php.path / perl.path 指向便携式可执行文件 → runtimes.source=config、execute 真跑通
 *   B 坏路径：路径不存在 → 该语言从 runtimes 消失、execute 明确 400（自动置灰）
 *   C disabled：PATH 里明明有 php / 配置里明明有 perl，但显式关闭优先 → 仍然不登记
 *   D 空 path：回退 PATH → php source=path；perl 按 PATH 里到底有没有它如实判
 *
 * ★ v0.7：Perl 用 Cygwin Perl，可执行文件不在 PATH、也没写注册表，是「手动配置运行时路径」
 *   的第一个真实用例。这里额外押 flavor=$^O、中文 UTF-8、Cygwin cwd/分隔符、LF 不转 CRLF。
 *   判据只押接口能看到的事实，不押日志文字；每个场景都重启节点（配置只在启动时读一次）。
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

/** 探测本机 Perl 可执行文件与宿主风味；返回 null 表示完全不可用。 */
function resolvePerl() {
  const detect = ['-e', 'printf "%s|%s\\n", $^V, $^O;'];
  const candidates = [];
  if (process.env.PLAYGROUND_PERL_EXE) candidates.push(process.env.PLAYGROUND_PERL_EXE);
  try {
    const local = JSON.parse(readFileSync(join(dir, 'runtimes.local.json'), 'utf8'));
    if (local?.runtimes?.perl?.path) candidates.push(local.runtimes.perl.path);
  } catch { /* 本机覆盖文件不存在就跳过 */ }
  candidates.push('D:/cygwin64/bin/perl.exe', 'C:/cygwin64/bin/perl.exe');

  const parse = (out) => /v?(\d+\.\d+\.\d+)\|(\w+)/.exec(out || '');
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    // Node 在 Windows 上给 CreateProcess 传反斜杠更稳；配置里仍写正斜杠（Go filepath.Abs 会规范）。
    const probe = spawnSync(c.replace(/\//g, '\\'), detect, { encoding: 'utf8' });
    const m = probe.status === 0 ? parse(probe.stdout) : null;
    if (m) return { exe: c.replace(/\\/g, '/'), version: m[1], flavor: m[2] };
  }
  const fallback = spawnSync('perl', detect, { encoding: 'utf8' });
  const m = fallback.status === 0 ? parse(fallback.stdout) : null;
  if (m) return { exe: '', version: m[1], flavor: m[2] };
  return null;
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

/** Perl 同理；代码走 JSON body（UTF-8），不经过 shell argv —— 中文不会被 cp936 转换吃掉。 */
function perlExecute(code, stdin = '') {
  return api('/api/v2/execute', {
    method: 'POST',
    body: JSON.stringify({
      language: 'perl', version: '*',
      files: [{ name: 'main.pl', content: code }],
      stdin, args: [],
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

  const perl = resolvePerl();
  if (!perl) {
    throw new Error('本机没有可用的 Perl，无法验证 Cygwin 配置路径；请设 PLAYGROUND_PERL_EXE 或在 runtimes.local.json 配 perl.path');
  }
  console.log(`[前置] 本机 Perl：${perl.exe || '(PATH)'} 版本 ${perl.version} 风味 ${perl.flavor}`);
  check('node/perl-executable', perl.exe === '' || existsSync(perl.exe),
    `exe=${perl.exe || '(PATH)'} version=${perl.version} flavor=${perl.flavor}`);

  // ---------- A 正常配置路径 ----------
  await startNode({
    runtimes: { go: { path: '' }, php: { path: phpExe }, perl: { path: perl.exe } },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    const go = list.find((x) => x.language === 'go');
    const php = list.find((x) => x.language === 'php');
    const perlEntry = list.find((x) => x.language === 'perl');
    check('config/runtimes-go-path-fallback', rt.status === 200 && !!go && go.source === 'path' && !!go.version,
      `go=${JSON.stringify(go ?? null)}`);
    check('config/runtimes-php-source-config', rt.status === 200 && !!php && php.source === 'config' && !!php.version,
      `php=${JSON.stringify(php ?? null)}`);
    check('config/runtimes-perl-source-config', !!perlEntry && perlEntry.source === (perl.exe ? 'config' : 'path') &&
      perlEntry.version === perl.version,
      `perl=${JSON.stringify(perlEntry ?? null)} 期望 version=${perl.version}`);
    check('config/runtimes-perl-flavor', !!perlEntry && perlEntry.flavor === perl.flavor,
      `flavor=${perlEntry?.flavor ?? '无'} 期望=${perl.flavor}`);

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

    // ---------- Perl / Cygwin 专属硬判据 ----------
    const perlRun = await perlExecute('print "NODE-PERL-CONFIG-OK\\n";');
    const perlOut = perlRun.body?.run?.stdout ?? '';
    const perlProbes = perlRun.body?.probes ?? {};
    check('config/perl-execute-really-runs', perlRun.status === 200 && perlOut.includes('NODE-PERL-CONFIG-OK'),
      `status=${perlRun.status} stdout=${perlOut.slice(0, 100)}`);
    check('config/perl-probes-flavor', perlProbes.runtimeFlavor === perl.flavor &&
      perlProbes.runtimeVersion === perl.version && perlProbes.stages === 'run' &&
      perlProbes.includePath === '-I.' && perlProbes.runtimePathSource === (perl.exe ? 'config' : 'path'),
      `probes=${JSON.stringify(perlProbes).slice(0, 260)}`);

    const cn = await perlExecute('use utf8; binmode(STDOUT, ":encoding(UTF-8)"); print "中文标记：昆明\\n";');
    check('config/perl-utf8', cn.status === 200 && (cn.body?.run?.stdout ?? '').includes('中文标记：昆明'),
      `status=${cn.status} stdout=${JSON.stringify((cn.body?.run?.stdout ?? '').slice(0, 80))}`);

    const sem = await perlExecute('use Cwd; use File::Spec; print "OS=$^O\\nCWD=", getcwd(), "\\nSEP=", File::Spec->catfile("a", "b"), "\\n";');
    const semOut = sem.body?.run?.stdout ?? '';
    const semOk = perl.flavor === 'cygwin'
      ? /OS=cygwin/.test(semOut) && /CWD=\/cygdrive\//.test(semOut) && /SEP=a\/b/.test(semOut)
      : semOut.includes('OS=' + perl.flavor) && /CWD=./.test(semOut);
    check('config/perl-host-semantics', sem.status === 200 && semOk,
      `flavor=${perl.flavor} out=${semOut.replace(/\n/g, ' | ').slice(0, 160)}`);

    const crlf = await perlExecute('print "A\\nB\\n";');
    const crlfOut = crlf.body?.run?.stdout ?? '';
    check('config/perl-no-crlf', crlf.status === 200 && crlfOut.includes('A\nB') && !crlfOut.includes('\r'),
      `stdout=${JSON.stringify(crlfOut.slice(0, 40))}`);
  }

  // ---------- B 坏路径 → 自动置灰 ----------
  await stopNode();
  await startNode({
    runtimes: {
      go: { path: '' },
      php: { path: join(tmpdir(), 'pg-no-such-php.exe') },
      perl: { path: join(tmpdir(), 'pg-no-such-perl.exe') },
    },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    check('badpath/php-not-registered', list.some((x) => x.language === 'go') &&
      !list.some((x) => x.language === 'php'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    check('badpath/perl-not-registered', !list.some((x) => x.language === 'perl'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    const health = await api('/health');
    check('badpath/health-explains-why', typeof health.body?.missing?.php === 'string' &&
      /path/.test(health.body.missing.php),
      `missing.php=${health.body?.missing?.php ?? '无'}`);
    const run = await phpExecute('<?php echo 1;');
    check('badpath/execute-rejected', run.status === 400 &&
      /runtime is unknown/.test(run.body?.message ?? ''),
      `status=${run.status} message=${run.body?.message ?? ''}`);
    const perlRun = await perlExecute('print 1;');
    check('badpath/perl-execute-rejected', perlRun.status === 400 &&
      /runtime is unknown/.test(perlRun.body?.message ?? ''),
      `status=${perlRun.status} message=${perlRun.body?.message ?? ''}`);
  }

  // ---------- C disabled 优先于 PATH / 配置 ----------
  await stopNode();
  await startNode({
    runtimes: {
      go: { path: '' },
      php: { path: '', disabled: true },
      perl: { path: perl.exe, disabled: true },
    },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    check('disabled/php-hidden-despite-path', list.some((x) => x.language === 'go') &&
      !list.some((x) => x.language === 'php'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    check('disabled/perl-hidden-despite-config', !list.some((x) => x.language === 'perl'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    const health = await api('/health');
    check('disabled/health-says-disabled', /disabled/.test(health.body?.missing?.php ?? '') &&
      /disabled/.test(health.body?.missing?.perl ?? ''),
      `missing=${JSON.stringify(health.body?.missing ?? {})}`);
  }

  // ---------- D 空 path 回退 PATH ----------
  await stopNode();
  await startNode({
    runtimes: { go: { path: '' }, php: { path: '' }, perl: { path: '' } },
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

    // ★ 便携式 Perl 的关键反证：PATH 里到底有没有 perl，节点就必须照实报。
    //   本机 Cygwin Perl 不在 PATH ⇒ 空 path 时 perl 必须消失，证明 A 场景全靠配置路径。
    const pathHasPerl = spawnSync('perl', ['-e', 'print 1;'], { encoding: 'utf8' }).status === 0;
    const perlEntry = list.find((x) => x.language === 'perl');
    check('fallback/perl-follows-path-truth',
      pathHasPerl
        ? !!perlEntry && perlEntry.source === 'path'
        : !perlEntry,
      `PATH 有 perl=${pathHasPerl} runtimes.perl=${JSON.stringify(perlEntry ?? null)}`);
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
