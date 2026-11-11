/**
 * Lua WASM runner 的共享真值：消息协议、纯函数判定、Lua 侧 bootstrap。
 *
 * 这个文件会被主 runner 和 Worker 各自打进自己的 chunk（体积很小），
 * 只放「不依赖 DOM / Worker / wasmoon」的纯逻辑，方便在 Node 单测里验。
 */
import type { RunFile } from '../../core/contract';

export interface LuaRunMessage {
  __pg: true;
  kind: 'run';
  requestId: string;
  code: string;
  files: RunFile[];
  stdin: string;
  memoryBytes: number;
}

export type LuaDoneStatus = 'ok' | 'error' | 'memory-limit' | 'internal' | 'unavailable';

export type LuaWorkerMessage =
  | { __pg: true; kind: 'ready'; luaVersion: string; wasmSource: string }
  | { __pg: true; kind: 'out'; stream: 'stdout' | 'stderr' | 'info'; text: string }
  | { __pg: true; kind: 'error'; message: string }
  | { __pg: true; kind: 'meta'; memoryUsed: string }
  | { __pg: true; kind: 'done'; status: LuaDoneStatus };

export function isLuaWorkerMessage(v: unknown): v is LuaWorkerMessage {
  return typeof v === 'object' && v !== null && (v as { __pg?: unknown }).__pg === true;
}

/**
 * 多文件挂载路径。按净结果判逃逸：只接受「一个干净的文件名」。
 * 拒绝路径分隔符、反斜杠、NUL、控制字符与任何 .. 段。
 */
export function luaMountPath(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/[\/\\\0\u0000-\u001f]/.test(trimmed)) return null;
  if (!/^[\p{L}\p{N}._-]+$/u.test(trimmed)) return null;
  if (trimmed.includes('..')) return null;
  if (trimmed === '.' || trimmed.startsWith('.\\')) return null;
  return `/${trimmed}`;
}

/** wasmoon 的 Lua allocator 触顶时抛 "not enough memory"，要映射到 memory-limit 而不是笼统的 error。 */
export function classifyLuaError(message: string): 'memory-limit' | 'error' {
  return /not enough memory|memory allocation|out of memory/i.test(message)
    ? 'memory-limit'
    : 'error';
}

/**
 * wasm 必须自托管：wasmoon 默认从 unpkg 拉，内网/离线直接失效。
 * 判据押「URL 同源且不含公共 CDN」，而不是押「加载没抛错」。
 */
export function isSelfHostedWasm(url: string, origin: string): boolean {
  if (!url) return false;
  if (/unpkg|jsdelivr|cdnjs|cdn\./i.test(url)) return false;
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * 每次运行前在 Lua 侧重建的一层薄壳。四个目的：
 *  1. print / io.write 走 __pg_out，绕开 Emscripten 的行缓冲（无换行输出不丢）。
 *  2. io.read 从 JS 注入的 stdin 全局逐行读；浏览器里没有真实 stdin。
 *  3. os.exit 会直接终止 WASM runtime，改成可读错误，避免丢输出。
 *  4. package.path 加上 /?.lua，让挂载到内存 FS 的第二个文件能被 require。
 *
 * 用 Lua 自己的 tostring 序列化，table 保持 "table: 0x..." 语义，
 * 不把 table 转成 JS Proxy 再猜格式。
 */
export const LUA_BOOTSTRAP = String.raw`
do
  local data = tostring(stdin or '')
  local pos = 1
  local function nextLine()
    if pos > #data then return nil end
    local s = data:find('\n', pos, true)
    local line
    if s then line = data:sub(pos, s - 1); pos = s + 1
    else line = data:sub(pos); pos = #data + 1 end
    if line:sub(-1) == '\r' then line = line:sub(1, -2) end
    return line
  end
  local function readAll()
    local first = nextLine()
    if first == nil then return nil end
    local rest = first
    while true do
      local l = nextLine()
      if l == nil then break end
      rest = rest .. '\n' .. l
    end
    return rest
  end
  local function readOne(fmt)
    if fmt == '*a' or fmt == 'a' then return readAll() end
    local line = nextLine()
    if line == nil then return nil end
    if fmt == '*n' or fmt == 'n' then return tonumber(line) end
    return line
  end
  if type(io) == 'table' then
    io.read = function(...)
      local n = select('#', ...)
      if n == 0 then return readOne('*l') end
      local res = {}
      for i = 1, n do res[i] = readOne(select(i, ...)) end
      return table.unpack(res, 1, n)
    end
    io.write = function(...)
      local parts = {}
      for i = 1, select('#', ...) do parts[i] = tostring(select(i, ...)) end
      __pg_out(table.concat(parts))
    end
  end
  print = function(...)
    local parts = {}
    for i = 1, select('#', ...) do parts[i] = tostring(select(i, ...)) end
    __pg_out(table.concat(parts, '\t') .. '\n')
  end
  warn = function(msg) __pg_err(tostring(msg) .. '\n') end
  if type(os) == 'table' then
    os.exit = function(code)
      error('os.exit 在浏览器 WASM 沙箱里不可用（code=' .. tostring(code) .. '）', 0)
    end
  end
  if type(package) == 'table' then
    package.path = '/?.lua;' .. package.path
  end
end
`;
