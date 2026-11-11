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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PLAYGROUND_PORT || 5188);
const CDP_PORT = Number(process.env.PLAYGROUND_CDP_PORT || 9333);
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

  const vite = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore', windowsHide: true },
  );
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
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.id && pending.has(data.id)) {
        const { resolve } = pending.get(data.id);
        pending.delete(data.id);
        resolve(data);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++msgId;
        pending.set(id, { resolve });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Runtime.enable');
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

    console.log(`[真机自检] 通过 ${report.passed} · 失败 ${report.failed} · 记账跳过 ${report.skipped} · 共 ${report.assertions.length} 条`);
    console.log(`[真机自检] 跳过清单：${report.skipIds.join(', ') || '无'}`);
    for (const a of report.assertions) {
      if (a.status === 'fail') console.log(`  [FAIL] ${a.id} ${a.name} — ${a.detail}`);
    }
    if (report.failed === 0 && report.ok) {
      console.log('[真机自检] 全绿：Worker / iframe / TS 转译 / 能力表接线都在真浏览器里跑通');
      verdict = 0;
    } else {
      console.error('[真机自检] 有红，见上方 FAIL 明细');
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
