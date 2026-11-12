/**
 * A′ 本地执行节点的构建 / 启动 / 复用 / 关闭，供 `npm run server` 与 smoke 共用。
 *
 * 纪律：判据前先探活。若 2000 端口已有节点在线（例如何工手动开着），直接复用，
 * 不重复起进程、也不在结束时误杀别人的进程。二进制不入库，go build 幂等。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'servers', 'local');
const exeName = process.platform === 'win32' ? 'playground-local.exe' : 'playground-local';
const exe = join(dir, 'bin', exeName);
const src = join(dir, 'main.go');

export const PORT = Number(process.env.PLAYGROUND_SERVER_PORT || 2000);
export const ADDR = `127.0.0.1:${PORT}`;
export const BASE = `http://127.0.0.1:${PORT}`;
export const TOKEN = process.env.PLAYGROUND_SERVER_TOKEN || 'pg-local-dev-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildIfNeeded() {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  if (existsSync(exe) && existsSync(src) && statSync(exe).mtimeMs >= statSync(src).mtimeMs) return;
  const r = spawnSync('go', ['build', '-o', exe, '.'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`编译本地执行节点失败：${(r.stderr || r.stdout || '').slice(-1500)}`);
  }
}

async function healthy() {
  try {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 返回 { started, stop }。started=false 表示复用了已在线节点，stop 是 no-op。
 */
export async function startLocalServer() {
  buildIfNeeded();
  if (await healthy()) return { started: false, stop: async () => undefined };

  const child = spawn(exe, ['-addr', ADDR, '-token', TOKEN], {
    cwd: dir, stdio: 'ignore', windowsHide: true,
  });
  let exited = false;
  child.once('exit', () => { exited = true; });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await healthy()) break;
    if (exited) throw new Error('本地执行节点启动后立即退出（端口被占用或 go 不可用）');
    await sleep(200);
  }
  if (!(await healthy())) throw new Error('等待本地执行节点 /health 超时（20s）');

  return {
    started: true,
    async stop() {
      if (exited) return;
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([done, sleep(3000)]);
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  buildIfNeeded();
  const child = spawn(exe, ['-addr', ADDR, '-token', TOKEN], { cwd: dir, stdio: 'inherit' });
  process.on('SIGINT', () => child.kill());
  process.on('SIGTERM', () => child.kill());
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
}
