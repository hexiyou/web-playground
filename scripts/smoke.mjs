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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PLAYGROUND_PORT || 5188);
const CDP_PORT = Number(process.env.PLAYGROUND_CDP_PORT || 9333);
const MODE =
  process.env.PLAYGROUND_MODE === 'preview' || process.argv.includes('--preview')
    ? 'preview'
    : 'dev';
const REPORT_FILE = process.env.PLAYGROUND_REPORT_FILE || '';
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET = `${BASE}/?selftest=1`;

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
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.id && pending.has(data.id)) {
        const { resolve } = pending.get(data.id);
        pending.delete(data.id);
        resolve(data);
      }
      // 网络守卫：probes 里的 URL 只是「代码声称从哪加载」，这里看真实发出的请求。
      // Pyodide 是第一个可能偷偷回退到 CDN 拉 wheel 的运行时，必须有这一层硬证据。
      if (data.method === 'Network.requestWillBeSent') {
        const url = String(data.params?.request?.url ?? '');
        if (/^https?:/i.test(url)) {
          (url.startsWith(BASE) ? localUrls : externalUrls).add(url);
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
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const reply = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      const value = reply?.result?.result?.value;
      if (value && value !== 'null') {
        report = JSON.parse(value);
        break;
      }
      await sleep(300);
    }

    if (!report) throw new Error('90 秒内页面没有产出自检报告');

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
    console.log(
      `[网络守卫] 同源请求 ${localUrls.size} 条（其中 /pyodide/ 资产 ${pyodideAssets.length} 条）· 外部请求 ${externalUrls.size} 条`,
    );
    if (externalUrls.size > 0) {
      console.log(`[网络守卫] 外部域名样本：${[...externalUrls].slice(0, 3).join(' , ')}`);
    }
    // 必须真的抓到 worker 的 /pyodide/ 资产请求，守卫才算「押到了对象」。
    // 否则「外部 0 条」可能只是压根没监听到 worker，属于静默空证据。
    const evidence = pyodideAssets.length >= 3;
    const networkOk = badRequests.length === 0 && evidence;
    if (!evidence) {
      console.error(
        `[网络守卫] 只抓到 ${pyodideAssets.length} 条 /pyodide/ 资产请求（应 ≥3），` +
          'worker target 可能没挂上，此时「零外部请求」不能作数',
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
  }
  process.exitCode = verdict;
}

await main();
