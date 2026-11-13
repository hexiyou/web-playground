/**
 * 真浏览器端到端冒烟：启动 Vite + 本机 Chromium(headless, CDP)，
 * 打开 ?selftest=1，轮询 window.__PLAYGROUND_SELFTEST__，读结构化报告。
 *
 * 不用 jsdom / happy-dom：Worker 的 terminate()、iframe 的 opaque origin 与
 * postMessage source 校验，只有真浏览器说得准。判据不能在自己写的假环境里自证。
 *
 * 需要 Node 22+（内置 WebSocket）。浏览器路径可用 PLAYGROUND_BROWSER 覆盖。
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer, BASE as SERVER_BASE } from './local-server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PLAYGROUND_PORT || 5188);
const CDP_PORT = Number(process.env.PLAYGROUND_CDP_PORT || 9333);
const MODE =
  process.env.PLAYGROUND_MODE === 'preview' || process.argv.includes('--preview')
    ? 'preview'
    : 'dev';
const REPORT_FILE = process.env.PLAYGROUND_REPORT_FILE || '';
/** 自检等待窗口。排障时可用 PLAYGROUND_SELFTEST_TIMEOUT_MS 缩短，别直接改死值。 */
const SELFTEST_TIMEOUT_MS = Number(process.env.PLAYGROUND_SELFTEST_TIMEOUT_MS || 150000);
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET = `${BASE}/?selftest=1`;
/** 本地执行节点是另一个端口，但它同样是「本地」，不能被算成外部请求。 */
const LOCAL_ORIGINS = [BASE, SERVER_BASE];

const CANDIDATES = [
  process.env.PLAYGROUND_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return await res.text();
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = String(err.message || err);
    }
    await sleep(250);
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）：${last}`);
}

function pickBrowser() {
  const found = CANDIDATES.find((p) => p && existsSync(p));
  if (!found) throw new Error('找不到 Chromium 浏览器，请设置 PLAYGROUND_BROWSER 指向 exe');
  return found;
}

async function main() {
  const exe = pickBrowser();
  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) throw new Error('先执行 npm install');

  // Go 只在 server 位置能跑，真机自检必须真有一个 A′ 执行节点在线；
  // 已在线则复用，不误杀何工手动开着的那个。
  const server = await startLocalServer();
  console.log(`[执行节点] ${server.started ? '已拉起' : '复用已在线'} A′ 节点 ${SERVER_BASE}`);

  // dev 与 preview 走同一套判据：dev 证明能开发，preview 证明 dist 产物里
  // glue.wasm 的 /assets/ 路径与 module Worker 也能跑（dev 路径完全不同）。
  const viteArgs = [
    viteBin,
    ...(MODE === 'preview' ? ['preview'] : []),
    '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
  ];
  const vite = spawn(process.execPath, viteArgs, {
    cwd: root, stdio: 'ignore', windowsHide: true,
  });
  const browser = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(root, '.smoke-profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      // 关掉浏览器自身的后台联网，免得 CDP 网络守卫把 Edge 的遥测/组件更新
      // 误判成 playground 发出的外部请求。
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--no-pings',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  let ws = null;
  let verdict = 1;
  try {
    await waitFor(BASE, 30000, 'Vite dev server');
    const version = await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000, 'CDP');
    if (!version.includes('webSocketDebuggerUrl')) throw new Error('CDP 端口答话但不是 DevTools');

    const created = await fetch(
      `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(TARGET)}`,
      { method: 'PUT' },
    );
    const tab = await created.json();
    if (!tab.webSocketDebuggerUrl) throw new Error('创建 tab 失败：' + JSON.stringify(tab));

    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let msgId = 0;
    const pending = new Map();
    const localUrls = new Set();
    const externalUrls = new Set();
    const pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.id && pending.has(data.id)) {
        const { resolve } = pending.get(data.id);
        pending.delete(data.id);
        resolve(data);
      }
      // 超时诊断：页面 JS 抛错会让自检根本不启动，只押「报告没出现」看不到原因。
      if (data.method === 'Runtime.exceptionThrown') {
        const d = data.params?.exceptionDetails ?? {};
        pageErrors.push(`[exception] ${d.text ?? ''} ${d.exception?.description ?? ''}`.trim().slice(0, 600));
      }
      if (data.method === 'Runtime.consoleAPICalled' &&
          (data.params?.type === 'error' || data.params?.type === 'warning')) {
        const args = (data.params?.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        pageErrors.push(`[console.${data.params.type}] ${args}`.slice(0, 400));
      }
      // 网络守卫：probes 里的 URL 只是「代码声称从哪加载」，这里看真实发出的请求。
      // Pyodide 是第一个可能偷偷回退到 CDN 拉 wheel 的运行时，必须有这一层硬证据。
      if (data.method === 'Network.requestWillBeSent') {
        const url = String(data.params?.request?.url ?? '');
        if (/^https?:/i.test(url)) {
          (LOCAL_ORIGINS.some((o) => url.startsWith(o)) ? localUrls : externalUrls).add(url);
        }
      }
      // module Worker 有独立 target：只在 page session 上 Network.enable 收不到
      // 它的请求，那时「外部请求 0 条」是空证据而不是零外联。flatten 自动挂上
      // worker session 后逐个别忘再 enable 一次。
      if (data.method === 'Target.attachedToTarget') {
        const sid = String(data.params?.sessionId ?? '');
        if (sid) void send('Network.enable', {}, sid);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = ++msgId;
        pending.set(id, { resolve });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    await send('Runtime.enable');
    await send('Network.enable');
    await send('Target.setDiscoverTargets', { discover: true });
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const expr = 'window.__PLAYGROUND_SELFTEST__ ? JSON.stringify(window.__PLAYGROUND_SELFTEST__) : null';
    let report = null;
    // Go 每次执行都要 go build（本机约 1.5s，冷编译更久），窗口比 v0.4 放宽。
    const deadline = Date.now() + SELFTEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const reply = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      const value = reply?.result?.result?.value;
      if (value && value !== 'null') {
        report = JSON.parse(value);
        break;
      }
      await sleep(300);
    }

    if (!report) {
      const stateExpr = `JSON.stringify({ready:document.readyState,hasReport:!!window.__PLAYGROUND_SELFTEST__,wiring:document.querySelector('#wiring')?.textContent??null,selftestHidden:document.querySelector('#selftest')?.hidden??null,bodyLen:document.body?.innerText?.length??0})`;
      const state = await send('Runtime.evaluate', { expression: stateExpr, returnByValue: true });
      console.error('[诊断] 页面状态：' + (state?.result?.result?.value ?? '无'));
      console.error('[诊断] 页面错误（末 25 条）：\n' + (pageErrors.slice(-25).join('\n') || '（无）'));
      console.error(`[诊断] 已抓请求：同源 ${localUrls.size}（/api/v2/ ${[...localUrls].filter((u) => u.includes('/api/v2/')).length} 条 /pyodide/ ${[...localUrls].filter((u) => u.includes('/pyodide/')).length} 条）· 外部 ${externalUrls.size}`);
      throw new Error(`${SELFTEST_TIMEOUT_MS} 秒内页面没有产出自检报告`);
    }

    if (REPORT_FILE) writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`[真机自检] 模式 ${MODE} · 通过 ${report.passed} · 失败 ${report.failed} · 记账跳过 ${report.skipped} · 共 ${report.assertions.length} 条`);
    console.log(`[真机自检] 跳过清单：${report.skipIds.join(', ') || '无'}`);
    for (const a of report.assertions) {
      if (a.status === 'fail') console.log(`  [FAIL] ${a.id} ${a.name} — ${a.detail}`);
    }
    // 已知公共包仓库：出现任意一条都说明运行时绕过了自托管资产。
    const PACKAGE_CDNS =
      /cdn\.jsdelivr\.net|jsdelivr|unpkg\.com|cdnjs|pypi\.org|files\.pythonhosted\.org|pyodide\.org|fastly\.net/i;
    const badRequests = [...externalUrls].filter((u) => PACKAGE_CDNS.test(u));
    const pyodideAssets = [...localUrls].filter((u) => u.includes('/pyodide/'));
    const serverCalls = [...localUrls].filter((u) => u.includes('/api/v2/'));
    console.log(
      `[网络守卫] 同源请求 ${localUrls.size} 条（/pyodide/ 资产 ${pyodideAssets.length} 条 · 本地节点 /api/v2/ ${serverCalls.length} 条）· 外部请求 ${externalUrls.size} 条`,
    );
    if (externalUrls.size > 0) {
      console.log(`[网络守卫] 外部域名样本：${[...externalUrls].slice(0, 3).join(' , ')}`);
    }
    // 必须真的抓到 worker 的 /pyodide/ 资产请求，守卫才算「押到了对象」。
    // 否则「外部 0 条」可能只是压根没监听到 worker，属于静默空证据。
    // ★ 服务端通路同理：只有抓到真实的 /api/v2/ 请求，才能证明 Go 真的走了本地执行节点，
    //   而不是 probes 里自述一句 isolation=process-only。
    const pyodideEvidence = pyodideAssets.length >= 3;
    const serverEvidence = serverCalls.length >= 2;
    const evidence = pyodideEvidence && serverEvidence;
    const networkOk = badRequests.length === 0 && evidence;
    if (!pyodideEvidence) {
      console.error(
        `[网络守卫] 只抓到 ${pyodideAssets.length} 条 /pyodide/ 资产请求（应 ≥3），` +
          'worker target 可能没挂上，此时「零外部请求」不能作数',
      );
    }
    if (!serverEvidence) {
      console.error(
        `[网络守卫] 只抓到 ${serverCalls.length} 条 /api/v2/ 请求（应 ≥2），` +
          'Go 的服务端通路可能没真跑起来，判据不能只信页面自述',
      );
    }
    if (networkOk) {
      console.log('[网络守卫] 零包仓库请求：Pyodide 全程只读同源自托管资产');
    } else if (badRequests.length > 0) {
      console.error(`[网络守卫] 检测到向公共包仓库的请求，自托管失效：${badRequests.slice(0, 3).join(' , ')}`);
    }

    if (report.failed === 0 && report.ok && networkOk) {
      console.log('[真机自检] 全绿：Worker / iframe / TS 转译 / 能力表接线 / 零外联都在真浏览器里跑通');
      verdict = 0;
    } else {
      if (report.failed !== 0 || !report.ok) console.error('[真机自检] 有红，见上方 FAIL 明细');
      if (!networkOk) console.error('[真机自检] 网络守卫未通过');
      verdict = 1;
    }
  } catch (err) {
    console.error('[真机自检] 执行异常：', err.message || err);
  } finally {
    if (ws) ws.close();
    browser.kill();
    vite.kill();
    await server.stop();
  }
  process.exitCode = verdict;
}

await main();
