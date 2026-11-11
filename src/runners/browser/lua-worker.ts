/**
 * Lua 5.4 WASM Worker（wasmoon 1.16.0）。
 *
 * 两条硬约束：
 *  1. glue.wasm 必须自托管。wasmoon 默认拼出 https://unpkg.com/wasmoon@<ver>/dist/glue.wasm，
 *     内网/离线直接失效；所以显式把 ?url 产出的同源地址传给 LuaFactory。
 *  2. 超时计时从「引擎就绪」开始，不把 wasm 下载 + 实例化算进用户代码的墙钟预算。
 *     Worker 先发 ready，主线程收到后才 postMessage(run) 并起 timer。
 *     doString 是同步 C 调用，一旦跑 while true 就会占死 Worker 线程 —— 只能靠主线程
 *     worker.terminate() 真杀，这同 JS runner 的理由一致。
 */
import { LuaFactory } from 'wasmoon';
import wasmUrl from 'wasmoon/dist/glue.wasm?url';
import { LUA_BOOTSTRAP, classifyLuaError, luaMountPath } from './lua-shared';
import type { LuaRunMessage, LuaWorkerMessage } from './lua-shared';

interface WorkerScope {
  postMessage(message: unknown): void;
  location: { href: string };
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

type LuaEngine = Awaited<ReturnType<LuaFactory['createEngine']>>;

let factory: LuaFactory | null = null;
let engine: LuaEngine | null = null;

function send(message: LuaWorkerMessage): void {
  scope.postMessage(message);
}

/** 顶层 return 值的可读化。wasmoon 返回的 table 可能是 Proxy，取属性会抛错，一律兜住。 */
function describe(value: unknown, depth = 2): string | null {
  if (value === undefined || value === null) return null;
  const kind = typeof value;
  if (kind === 'string') return value as string;
  if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(value);
  if (kind === 'function') return '[function]';
  if (depth <= 0) return '[table]';
  try {
    if (Array.isArray(value)) {
      return `[${value.slice(0, 20).map((v) => describe(v, depth - 1) ?? 'nil').join(', ')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).slice(0, 20);
    return `{${keys.map((k) => `${k}: ${describe(record[k], depth - 1) ?? 'nil'}`).join(', ')}}`;
  } catch {
    return '[unserializable]';
  }
}

async function boot(): Promise<void> {
  try {
    // ?url 在 dev 下是 /node_modules/...，build 下是 /assets/glue-<hash>.wasm；
    // 绝对化之后 both 同源，判据可以直接押 URL 而不押「加载没抛错」。
    const wasmSource = new URL(wasmUrl, scope.location.href).href;
    const f = new LuaFactory(wasmSource);
    const lua = await f.createEngine({ traceAllocations: true });
    lua.global.set('__pg_out', (text: unknown) => {
      send({ __pg: true, kind: 'out', stream: 'stdout', text: String(text) });
    });
    lua.global.set('__pg_err', (text: unknown) => {
      send({ __pg: true, kind: 'out', stream: 'stderr', text: String(text) });
    });
    factory = f;
    engine = lua;
    send({
      __pg: true,
      kind: 'ready',
      luaVersion: String(lua.global.get('_VERSION') ?? ''),
      wasmSource,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ __pg: true, kind: 'error', message: `Lua WASM 运行时初始化失败：${message}` });
    send({ __pg: true, kind: 'done', status: 'unavailable' });
  }
}

async function execute(msg: LuaRunMessage): Promise<void> {
  if (!engine || !factory) {
    send({ __pg: true, kind: 'error', message: 'Lua 引擎未就绪' });
    send({ __pg: true, kind: 'done', status: 'unavailable' });
    return;
  }
  const lua = engine;
  try {
    lua.global.set('stdin', msg.stdin);
    // traceAllocations:true 才允许 setMemoryMax / getMemoryUsed，否则 wasmoon 直接抛错。
    lua.global.setMemoryMax(msg.memoryBytes);
    await lua.doString(LUA_BOOTSTRAP);

    for (const file of msg.files.slice(1)) {
      const path = luaMountPath(file.name);
      if (path) await factory.mountFile(path, file.content);
    }

    const returned = await lua.doString(msg.code);
    const text = describe(returned);
    if (text !== null) {
      send({ __pg: true, kind: 'out', stream: 'info', text: `↳ 返回：${text}` });
    }
    send({ __pg: true, kind: 'meta', memoryUsed: String(lua.global.getMemoryUsed()) });
    send({ __pg: true, kind: 'done', status: 'ok' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ __pg: true, kind: 'error', message });
    send({ __pg: true, kind: 'done', status: classifyLuaError(message) });
  }
}

scope.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as Partial<LuaRunMessage> | undefined;
  if (data?.__pg === true && data.kind === 'run') {
    void execute(data as LuaRunMessage);
  }
});

void boot();
