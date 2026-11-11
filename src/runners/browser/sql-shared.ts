/**
 * SQL WASM runner 的共享真值：消息协议、纯函数判定、结果集格式化。
 *
 * 与 lua-shared.ts 同构：只放「不依赖 DOM / Worker / sql.js」的纯逻辑，
 * 这样主 runner、Worker 各自打进自己的 chunk 也能在 Node 单测里直接验。
 */
import type { RunFile } from '../../core/contract';

/** undefined 也按 NULL 兜底，防御 sql.js 未来把缺失值改成 undefined。 */
export type SqlCell = number | string | Uint8Array | null | undefined;

export interface SqlRunMessage {
  __pg: true;
  kind: 'run';
  requestId: string;
  code: string;
  files: RunFile[];
  outputBytes: number;
  maxRows: number;
}

export type SqlDoneStatus =
  | 'ok'
  | 'error'
  | 'output-limit'
  | 'memory-limit'
  | 'internal'
  | 'unavailable';

export type SqlWorkerMessage =
  | { __pg: true; kind: 'ready'; sqliteVersion: string; wasmSource: string }
  | { __pg: true; kind: 'out'; stream: 'stdout' | 'stderr' | 'info'; text: string }
  | { __pg: true; kind: 'error'; message: string }
  | {
      __pg: true;
      kind: 'meta';
      statements: string;
      rows: string;
      dbBytes: string;
      outputLimited: string;
      rowLimited: string;
      memoryCapability: string;
    }
  | { __pg: true; kind: 'done'; status: SqlDoneStatus };

export function isSqlWorkerMessage(v: unknown): v is SqlWorkerMessage {
  return typeof v === 'object' && v !== null && (v as { __pg?: unknown }).__pg === true;
}

/** 结果集行数硬护栏：sql.js 没有 allocator 上限，只能用「行数 + 输出字节 + 墙钟」三道闸。 */
export const MAX_SQL_ROWS = 5000;

/**
 * 如实登记能力缺口，不谎报内存限额。
 * wasmoon 有 setMemoryMax，sql.js 没有任何等价 API；Emscripten 的
 * ALLOW_MEMORY_GROWTH 也不接受调用方设上限。能力表/probes 一律照这条报。
 */
export const SQL_MEMORY_CAPABILITY =
  'no-allocator-cap: 仅墙钟超时 + 输出字节 + 行数上限 + Worker 隔离';

/** 复用 Lua 那轮已验证过的同源判定，不重复实现同一条规则。 */
export { isSelfHostedWasm } from './lua-shared';

/** 附加文件都当初始化 SQL 脚本，按顺序在用户主脚本之前执行。 */
export function sqlInitFiles(files: readonly RunFile[]): RunFile[] {
  return files.slice(1).filter((f) => typeof f.content === 'string' && f.content.trim().length > 0);
}

export function sqlInitScript(files: readonly RunFile[]): string {
  return sqlInitFiles(files)
    .map((f) => `-- ===== ${f.name.replace(/[\r\n]/g, ' ')} =====\n${f.content}`)
    .join('\n');
}

/**
 * WASM 内存增长失败时 Emscripten 会抛这几类错，映射到 memory-limit；
 * 其余（语法错误、no such table…）都是普通 SQL 错误。
 */
export function classifySqlError(message: string): 'memory-limit' | 'error' {
  return /out of memory|not enough memory|cannot enlarge memory arrays|aborted\(oom\)|memory access out of bounds/i.test(
    message,
  )
    ? 'memory-limit'
    : 'error';
}

/** BLOB 走十六进制、NULL 显式、换行转义；不做列宽对齐（中文全角会把表格推歪）。 */
export function formatCell(value: SqlCell): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) {
    const head = Array.from(value.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `X'${head}${value.length > 16 ? '…' : ''}'`;
  }
  if (typeof value === 'number') return String(value);
  return String(value).replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

export function formatRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

export function formatSeparator(count: number): string {
  return `| ${Array.from({ length: count }, () => '---').join(' | ')} |`;
}
