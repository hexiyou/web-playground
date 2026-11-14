/**
 * A′ 节点层判据：手动配置运行时路径 + runtimes 动态探测 + 宿主风味 + 入口形态。
 *
 * 真机自检（浏览器里跑）只能看到「PHP / Perl / R / Ruby 能跑」，看不到「路径配置到底有没有生效」；
 * 这里直接打节点的 HTTP 接口，用五个场景把可观察副作用钉死：
 *   A 正常配置：php / perl / r 的 path 指向便携式入口，ruby 留空走 PATH →
 *     runtimes.source=config|path、execute 真跑通；同时注入宿主 RUBYOPT / RUBYLIB 验证净化
 *   B 坏路径：路径不存在 → 该语言从 runtimes 消失、execute 明确 400（自动置灰）
 *   C disabled：PATH 里明明有 php / ruby，配置里明明有 perl 与 r，但显式关闭优先 → 仍然不登记
 *   D 空 path：回退 PATH → php / ruby source=path；perl / r 按 PATH 里到底有没有它如实判
 *   E 脚本包装器缺失：把 r 入口拷到没有 sh.exe 的临时目录 → r 不登记、health.missing 说明原因、
 *     execute 400（反证 wrapEntry 不是摆设：脚本型入口没包装器就绝不能谎报可用）
 *
 * ★ v0.7：Perl 用 Cygwin Perl，可执行文件不在 PATH、也没写注册表，是「手动配置运行时路径」
 *   的第一个真实用例。这里额外押 flavor=$^O、中文 UTF-8、Cygwin cwd/分隔符、LF 不转 CRLF。
 * ★ v0.8：R 的入口是 #!/bin/sh 脚本而非 PE，节点走通用 wrapEntry + envFromTool 包装与环境净化；
 *   A 场景押 entryKind / wrapper / flavor / 宿主 BASH_FUNC 净化后 stderr 干净 / stats 不谎报。
 * ★ v0.9：Ruby 是反例 —— RubyInstaller 的 ruby.exe 是原生 PE，PATH 里能直接发现，既不需要
 *   wrapEntry 也不需要 envFromTool。这里押 source=path、入口不是 shebang、宿主 RUBYOPT/RUBYLIB
 *   被剥、Windows 原生 puts 的 CRLF 如实回传（节点不归一化）、-I . 让 require 同目录文件可用。
 *   判据只押接口能看到的事实，不押日志文字；每个场景都重启节点（配置只在启动时读一次）。
 *   共 62 条：node 6 · config 36 · badpath 7 · disabled 5 · fallback 5 · wrapper 3。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
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

async function startNode(config, extraEnv = {}) {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  child = spawn(exe, ['-addr', `127.0.0.1:${PORT}`, '-token', TOKEN, '-config', configPath], {
    cwd: dir, stdio: 'ignore', windowsHide: true,
    // ★ v0.9：A 场景故意注入宿主 RUBYOPT / RUBYLIB，否则「环境净化」判据天生恒绿。
    env: { ...process.env, ...extraEnv },
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

/**
 * ★ v0.8：R 的入口不是可执行文件而是 #!/bin/sh 脚本。这里绝不用 spawnSync 直接跑它
 * （Windows 会报 WinError 193），只读文件头确认「它确实是脚本」+ 同目录有 sh.exe。
 * 版本与风味一律以节点 /api/v2/runtimes 的探测结果为准，不在这里另造一套真值。
 */
function resolveR() {
  const candidates = [];
  if (process.env.PLAYGROUND_R_EXE) candidates.push(process.env.PLAYGROUND_R_EXE);
  try {
    const local = JSON.parse(readFileSync(join(dir, 'runtimes.local.json'), 'utf8'));
    if (local?.runtimes?.r?.path) candidates.push(local.runtimes.r.path);
  } catch { /* 本机覆盖文件不存在就跳过 */ }
  candidates.push('D:/cygwin64/bin/r', 'C:/cygwin64/bin/r');
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const head = readFileSync(c).subarray(0, 64).toString('utf8');
    const shell = join(dirname(c), 'sh.exe');
    return { path: c.replace(/\\/g, '/'), isScript: /^#!\s*\S*sh\b/.test(head), hasShell: existsSync(shell), head: head.trim() };
  }
  return null;
}

/** R 的最小执行请求；中文走 JSON body，不经过 shell argv。 */
function rExecute(code, stdin = '') {
  return api('/api/v2/execute', {
    method: 'POST',
    body: JSON.stringify({
      language: 'r', version: '*',
      files: [{ name: 'main.R', content: code }],
      stdin, args: [],
      compile_timeout: 10000, run_timeout: 6000, output_max_size: 65536,
    }),
  });
}

/**
 * ★ v0.9：Ruby 由 PATH 直接发现，解释器自己报版本 / 平台 / 可执行文件路径。
 * 入口形态也在这里验：R 是 #!/bin/sh 脚本，Ruby 必须是原生可执行（PE / ELF）。
 * 不硬编码 4.0.9 或 mingw，换机器 / 换 Ruby 发行版判据照样成立。
 */
function resolveRuby() {
  const probe = spawnSync('ruby', ['-e', 'require "rbconfig"; puts "#{RUBY_VERSION}|#{RUBY_PLATFORM}|#{RbConfig.ruby}"'],
    { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout?.trim()) return null;
  const [version, platform, exe] = probe.stdout.trim().split('|');
  const flavor = /(?:mingw|mswin|cygwin|linux|darwin)/.exec(platform ?? '')?.[0] ?? '';
  if (!version || !exe) return null;
  let head = '';
  try { head = readFileSync(exe).subarray(0, 4).toString('utf8'); } catch { /* 读不到就如实置灰 */ }
  return { version, platform, flavor, exe: exe.replace(/\\/g, '/'), head };
}

/** Ruby 的最小执行请求；中文一律走 JSON body，不经过 shell argv。 */
function rubyExecute(code, stdin = '') {
  return api('/api/v2/execute', {
    method: 'POST',
    body: JSON.stringify({
      language: 'ruby', version: '*',
      files: [{ name: 'main.rb', content: code }],
      stdin, args: [],
      compile_timeout: 10000, run_timeout: 6000, output_max_size: 65536,
    }),
  });
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

  const r = resolveR();
  if (!r) {
    throw new Error('本机没有 Cygwin R 入口；请设 PLAYGROUND_R_EXE 或在 runtimes.local.json 配 r.path');
  }
  console.log(`[前置] R 入口：${r.path} 脚本=${r.isScript} sh.exe=${r.hasShell} 头部=${r.head}`);
  check('node/r-entry-is-script', r.isScript, `入口文件头=${r.head}`);
  check('node/r-shell-present', r.hasShell, `同目录 sh.exe 存在=${r.hasShell}`);

  const ruby = resolveRuby();
  if (!ruby) {
    throw new Error('PATH 里没有可用的 ruby；请先安装 Ruby 或在 runtimes.local.json 配 ruby.path');
  }
  console.log(`[前置] Ruby：${ruby.exe} 版本 ${ruby.version} 平台 ${ruby.platform} 风味 ${ruby.flavor}`);
  check('node/ruby-executable', existsSync(ruby.exe), `RbConfig.ruby 指向的文件存在=${existsSync(ruby.exe)}`);
  check('node/ruby-entry-is-native', ruby.head.length > 0 && !ruby.head.startsWith('#!'),
    `入口头=${JSON.stringify(ruby.head)}（原生 PE/ELF，不是 shebang 脚本）`);

  // ---------- A 正常配置路径 ----------
  // ★ 故意注入宿主 Ruby 启动选项与 gem 路径：没净化时 Ruby 会读到，判据必须抓到。
  await startNode({
    runtimes: {
      go: { path: '' }, php: { path: phpExe }, perl: { path: perl.exe },
      r: { path: r.path }, ruby: { path: '' },
    },
  }, { RUBYOPT: '-rjson', RUBYLIB: tmpdir() });
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
    const rEntry = list.find((x) => x.language === 'r');
    check('config/runtimes-r-source-config', !!rEntry && rEntry.source === 'config' &&
      /^\d+\.\d+/.test(rEntry.version ?? '') && !!rEntry.flavor,
      `r=${JSON.stringify(rEntry ?? null)}`);

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

    // ---------- R / 脚本型入口专属硬判据 ----------
    if (r.isScript) {
      const direct = spawnSync(r.path.replace(/\//g, '\\'), ['--version'], { encoding: 'utf8' });
      check('config/r-direct-exec-fails', !!direct.error || direct.status !== 0,
        `Windows CreateProcess 不能直接跑 shebang 脚本：error=${direct.error?.code ?? '无'} status=${direct.status}`);
    }
    const rRun = await rExecute('cat("NODE-R-CONFIG-OK\\n");');
    const rOut = rRun.body?.run?.stdout ?? '';
    const rErr = rRun.body?.run?.stderr ?? '';
    const rProbes = rRun.body?.probes ?? {};
    check('config/r-execute-really-runs', rRun.status === 200 && rOut.includes('NODE-R-CONFIG-OK'),
      `status=${rRun.status} stdout=${rOut.slice(0, 100)}`);
    check('config/r-probes-script-wrapper', rProbes.entryKind === 'shell-script;#!/bin/sh' &&
      rProbes.wrapper === 'sh.exe <script>' && rProbes.stages === 'run' &&
      rProbes.runtimePathSource === 'config' && rProbes.network === 'no-enforcement;serverSocket-available',
      `probes=${JSON.stringify(rProbes).slice(0, 300)}`);
    // ★ 最关键：宿主 BASH_FUNC_RM%% / BASH_ENV / MSYS2 PATH 只要漏一个进 Cygwin sh，
    //   R 启动调用的 rm 就会命中 WorkBuddy 的 CRLF 版 safe-bin 脚本，stderr 刷一屏报错。
    check('config/r-clean-host-env', !/safe-bin|pipefail|command not found/.test(rErr),
      `stderr=${JSON.stringify(rErr.slice(0, 180))}`);
    // 不谎报：stats 加载不了就必须有启动告警；设 R_DEFAULT_PACKAGES 把它盖掉是错的。
    const truth = await rExecute('cat("STATS=", requireNamespace("stats", quietly=TRUE), "\\n");');
    const truthOut = truth.body?.run?.stdout ?? '';
    const truthErr = truth.body?.run?.stderr ?? '';
    const statsFalse = /STATS=\s*FALSE/.test(truthOut);
    check('config/r-default-packages-truth', /STATS=\s*(TRUE|FALSE)/.test(truthOut) &&
      (!statsFalse || /defaultPackages/.test(truthErr)),
      `out=${truthOut.trim()} stderr含告警=${/defaultPackages/.test(truthErr)}`);
    const cnR = await rExecute('cat("你好，昆明\\n");');
    check('config/r-utf8', (cnR.body?.run?.stdout ?? '').includes('你好，昆明'),
      `stdout=${JSON.stringify((cnR.body?.run?.stdout ?? '').slice(0, 80))}`);
    const stdinR = await rExecute('x <- readLines("stdin", n=1, warn=FALSE); cat("STDIN:", x, "\\n");', 'marker-42\n');
    check('config/r-stdin', (stdinR.body?.run?.stdout ?? '').includes('marker-42'),
      `stdout=${JSON.stringify((stdinR.body?.run?.stdout ?? '').slice(0, 80))}`);
    const semR = await rExecute('cat("os=", R.version$os, "\\nwd=", getwd(), "\\n");');
    const semROut = semR.body?.run?.stdout ?? '';
    check('config/r-host-semantics', new RegExp(`os=\\s*${rEntry?.flavor ?? 'cygwin'}`).test(semROut) &&
      /wd=\s*\/cygdrive\//.test(semROut),
      `flavor=${rEntry?.flavor} out=${semROut.replace(/\n/g, ' | ').slice(0, 160)}`);
    const sockR = await rExecute('cat(tryCatch({ s <- serverSocket(0); close(s); "SOCKET-OK" }, error=function(e) "SOCKET-ERR"), "\\n");');
    check('config/r-socket-available', (sockR.body?.run?.stdout ?? '').includes('SOCKET-OK'),
      `stdout=${JSON.stringify((sockR.body?.run?.stdout ?? '').slice(0, 80))}`);
    const crlfR = await rExecute('cat("A\\nB\\n");');
    const crlfROut = crlfR.body?.run?.stdout ?? '';
    check('config/r-no-crlf', crlfROut.includes('A\nB') && !crlfROut.includes('\r'),
      `stdout=${JSON.stringify(crlfROut.slice(0, 40))}`);

    // ---------- Ruby / 原生 PE 入口 + 纯 PATH 探测专属硬判据 ----------
    const rubyEntry = list.find((x) => x.language === 'ruby');
    check('config/runtimes-ruby-source-path', !!rubyEntry && rubyEntry.source === 'path' &&
      rubyEntry.version === ruby.version,
      `ruby=${JSON.stringify(rubyEntry ?? null)} 期望 version=${ruby.version}`);
    check('config/runtimes-ruby-flavor', !!rubyEntry && rubyEntry.flavor === ruby.flavor,
      `flavor=${rubyEntry?.flavor ?? '无'} 期望=${ruby.flavor}`);

    const rbRun = await rubyExecute('puts "NODE-RUBY-PATH-OK"');
    const rbOut = rbRun.body?.run?.stdout ?? '';
    const rbProbes = rbRun.body?.probes ?? {};
    check('config/ruby-execute-really-runs', rbRun.status === 200 && rbOut.includes('NODE-RUBY-PATH-OK'),
      `status=${rbRun.status} stdout=${JSON.stringify(rbOut.slice(0, 80))}`);
    check('config/ruby-probes-native-entry', rbProbes.entryKind === 'native-executable;no-wrapper' &&
      rbProbes.stages === 'run' && rbProbes.runtimePathSource === 'path' &&
      rbProbes.includePath === '-I.' && rbProbes.lineEndings === 'no-normalization;platform-native' &&
      /no-enforcement/.test(rbProbes.network ?? ''),
      `probes=${JSON.stringify(rbProbes).slice(0, 320)}`);

    const rbVer = await rubyExecute('puts RUBY_VERSION');
    check('config/ruby-version-self-report', (rbVer.body?.run?.stdout ?? '').trim() === ruby.version,
      `self=${JSON.stringify((rbVer.body?.run?.stdout ?? '').trim())} 期望=${ruby.version}`);

    // ★ 宿主污染是故意造的：没剥干净时这两个变量会被 Ruby 读到，判据才不是恒绿。
    const rbEnv = await rubyExecute(`puts "RUBYOPT=#{ENV['RUBYOPT'].inspect}|RUBYLIB=#{ENV['RUBYLIB'].inspect}"`);
    const rbEnvOut = rbEnv.body?.run?.stdout ?? '';
    check('config/ruby-clean-host-env', /RUBYOPT=nil\|RUBYLIB=nil/.test(rbEnvOut),
      `stdout=${JSON.stringify(rbEnvOut.slice(0, 120))}（宿主注入 RUBYOPT=-rjson / RUBYLIB）`);

    const rbCn = await rubyExecute('puts "中文标记：昆明"');
    check('config/ruby-utf8', (rbCn.body?.run?.stdout ?? '').includes('中文标记：昆明'),
      `stdout=${JSON.stringify((rbCn.body?.run?.stdout ?? '').slice(0, 80))}`);

    const rbStdin = await rubyExecute('puts "STDIN=#{STDIN.gets&.strip}"', 'marker-42\n');
    check('config/ruby-stdin', (rbStdin.body?.run?.stdout ?? '').includes('marker-42'),
      `stdout=${JSON.stringify((rbStdin.body?.run?.stdout ?? '').slice(0, 80))}`);

    const rbJson = await rubyExecute('require "json"; puts JSON.generate({ok: true})');
    check('config/ruby-stdlib-json', (rbJson.body?.run?.stdout ?? '').includes('{"ok":true}'),
      `stdout=${JSON.stringify((rbJson.body?.run?.stdout ?? '').slice(0, 80))}`);

    // Ruby 1.9+ 把 . 移出 $LOAD_PATH：节点加 -I . 后，附加同目录文件才能 require。
    const rbReq = await api('/api/v2/execute', {
      method: 'POST',
      body: JSON.stringify({
        language: 'ruby', version: '*',
        files: [
          { name: 'main.rb', content: 'require "helper"\nputs "HELPER=#{helper_value}"' },
          { name: 'helper.rb', content: 'def helper_value\n  42\nend\n' },
        ],
        stdin: '', args: [], compile_timeout: 10000, run_timeout: 6000, output_max_size: 65536,
      }),
    });
    check('config/ruby-require-dot', (rbReq.body?.run?.stdout ?? '').includes('HELPER=42'),
      `stdout=${JSON.stringify((rbReq.body?.run?.stdout ?? '').slice(0, 80))} stderr=${JSON.stringify((rbReq.body?.run?.stderr ?? '').slice(0, 120))}`);

    const rbSock = await rubyExecute('require "socket"; s = TCPServer.new("127.0.0.1", 0); puts "SOCKET-OK"; s.close');
    check('config/ruby-socket-available', (rbSock.body?.run?.stdout ?? '').includes('SOCKET-OK'),
      `stdout=${JSON.stringify((rbSock.body?.run?.stdout ?? '').slice(0, 80))}`);

    // ★ 与 Cygwin Perl 的 LF 相反：Windows 原生 Ruby 的 puts/write 会输出 CRLF。
    //   节点不改写一个字节，判据按解释器自报的风味押「该有的换行」，换 Linux 不误红。
    const rbCrlf = await rubyExecute('STDOUT.write("A\\nB\\n")');
    const rbCrlfOut = rbCrlf.body?.run?.stdout ?? '';
    const windowsRuby = /mingw|mswin/.test(ruby.flavor);
    check('config/ruby-line-endings-truth',
      windowsRuby ? rbCrlfOut.includes('A\r\nB\r\n') : rbCrlfOut.includes('A\nB') && !rbCrlfOut.includes('\r'),
      `flavor=${ruby.flavor} stdout=${JSON.stringify(rbCrlfOut.slice(0, 40))}`);
  }

  // ---------- B 坏路径 → 自动置灰 ----------
  await stopNode();
  await startNode({
    runtimes: {
      go: { path: '' },
      php: { path: join(tmpdir(), 'pg-no-such-php.exe') },
      perl: { path: join(tmpdir(), 'pg-no-such-perl.exe') },
      r: { path: join(tmpdir(), 'pg-no-such-r') },
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
    check('badpath/r-not-registered', !list.some((x) => x.language === 'r'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    const rRun = await rExecute('cat(1);');
    check('badpath/r-execute-rejected', rRun.status === 400 &&
      /runtime is unknown/.test(rRun.body?.message ?? ''),
      `status=${rRun.status} message=${rRun.body?.message ?? ''}`);
  }

  // ---------- C disabled 优先于 PATH / 配置 ----------
  await stopNode();
  await startNode({
    runtimes: {
      go: { path: '' },
      php: { path: '', disabled: true },
      perl: { path: perl.exe, disabled: true },
      r: { path: r.path, disabled: true },
      ruby: { path: '', disabled: true },
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
    check('disabled/r-hidden-despite-config', !list.some((x) => x.language === 'r'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    check('disabled/health-says-disabled', /disabled/.test(health.body?.missing?.php ?? '') &&
      /disabled/.test(health.body?.missing?.perl ?? '') && /disabled/.test(health.body?.missing?.r ?? '') &&
      /disabled/.test(health.body?.missing?.ruby ?? ''),
      `missing=${JSON.stringify(health.body?.missing ?? {})}`);
    // ★ PATH 里明明有 ruby.exe，「关」必须是第一句，不能因为探测得到就重新冒出来。
    check('disabled/ruby-hidden-despite-path', !list.some((x) => x.language === 'ruby'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
  }

  // ---------- D 空 path 回退 PATH ----------
  await stopNode();
  await startNode({
    runtimes: { go: { path: '' }, php: { path: '' }, perl: { path: '' }, r: { path: '' }, ruby: { path: '' } },
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
    // R 入口是脚本，Windows CreateProcess 直接跑不了 ⇒ 空 path 时也必须从能力表消失。
    const pathHasR = spawnSync('r', ['--version'], { encoding: 'utf8' }).status === 0;
    const rFallback = list.find((x) => x.language === 'r');
    check('fallback/r-follows-path-truth',
      pathHasR ? !!rFallback && rFallback.source === 'path' : !rFallback,
      `PATH 有 r=${pathHasR} runtimes.r=${JSON.stringify(rFallback ?? null)}`);
    // Ruby 是「PATH 里真有、且不配任何绝对路径」的正向真值：能力与 source 都照实报。
    const rubyFallback = list.find((x) => x.language === 'ruby');
    check('fallback/ruby-follows-path-truth', !!rubyFallback &&
      rubyFallback.source === 'path' && rubyFallback.version === ruby.version,
      `runtimes.ruby=${JSON.stringify(rubyFallback ?? null)} 期望 version=${ruby.version}`);
  }

  // ---------- E 脚本包装器缺失 → 必须置灰（反证 wrapEntry 不是摆设） ----------
  // 放一个真的 #!/bin/sh 脚本，但同目录不给 sh.exe：节点必须报「脚本包装器不可用」，
  // 而不是拿 Windows 直接 exec 撞 WinError 193 后含糊失败，更不能谎报已登记。
  const fakeDir = join(tmpdir(), `pg-r-nosh-${process.pid}`);
  mkdirSync(fakeDir, { recursive: true });
  const fakeR = join(fakeDir, 'r');
  writeFileSync(fakeR, '#!/bin/sh\necho "R version 9.9.9"\n');
  await stopNode();
  await startNode({
    runtimes: { go: { path: '' }, php: { path: '' }, perl: { path: '' }, r: { path: fakeR } },
  });
  {
    const rt = await api('/api/v2/runtimes');
    const list = Array.isArray(rt.body) ? rt.body : [];
    check('wrapper/r-not-registered-without-sh', !list.some((x) => x.language === 'r'),
      `runtimes=${list.map((x) => x.language).join(',') || '空'}`);
    const health = await api('/health');
    check('wrapper/health-explains-missing-shell', /脚本包装器/.test(health.body?.missing?.r ?? ''),
      `missing.r=${health.body?.missing?.r ?? '无'}`);
    const run = await rExecute('cat(1);');
    check('wrapper/execute-rejected', run.status === 400 &&
      /runtime is unknown/.test(run.body?.message ?? ''),
      `status=${run.status} message=${run.body?.message ?? ''}`);
  }
  rmSync(fakeDir, { recursive: true, force: true });

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
