/**
 * SQLite WASM Worker（sql.js 1.16.0 / SQLite 3.54.1）。
 *
 * 三条硬约束：
 *  1. sql-wasm-browser.wasm 必须自托管。sql.js 默认按 scriptDirectory 拼
 *     "sql-wasm-browser.wasm"，在 module Worker 里这个前缀不可靠；显式传
 *     locateFile 指向 ?url 产出的同源绝对地址，dev 与 dist 都成立。
 *  2. 两阶段计时：Worker 先 boot 发 ready，主线程收到才起墙钟并投递 SQL。
 *     wasm 下载 + 实例化不算用户代码预算。
 *  3. 不用 db.exec()。exec 会一次性把整个结果集物化进 JS 数组，输出限额
 *     挡不住内存；改用 iterateStatements + stmt.step() 逐行读，边读边 emit，
 *     触到 outputBytes / maxRows 立即停。这样「输出超限」是可计数的量，
 *     而不是事后才发现的一句提示。
 *
 * 能力缺口如实登记：sql.js 没有 wasmoon 那样的 setMemoryMax，Emscripten 的
 * ALLOW_MEMORY_GROWTH 不接受调用方设上限 ⇒ 只有墙钟 + 输出字节 + 行数 + Worker
 * 隔离四道闸，probes.memoryCapability 明确写 no-allocator-cap，绝不谎报内存限额。
 */
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import {
  SQL_MEMORY_CAPABILITY,
  classifySqlError,
  formatCell,
  formatRow,
  formatSeparator,
  sqlInitScript,
} from './sql-shared';
import type { SqlDoneStatus, SqlRunMessage, SqlWorkerMessage } from './sql-shared';

interface WorkerScope {
  postMessage(message: unknown): void;
  location: { href: string };
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;

let SQL: SqlJsStatic | null = null;
let wasmSource = '';
let sqliteVersion = '';

function send(message: SqlWorkerMessage): void {
  scope.postMessage(message);
}

async function boot(): Promise<void> {
  try {
    // ?url 在 dev 下是 /node_modules/...，build 下是 /assets/sql-wasm-browser-<hash>.wasm。
    // 绝对化之后两者都同源，判据可以直接押 URL，而不是押「加载没抛错」。
    wasmSource = new URL(wasmUrl, scope.location.href).href;
    SQL = await initSqlJs({ locateFile: () => wasmSource });
    const probe = new SQL.Database();
    try {
      const rows = probe.exec('SELECT sqlite_version() AS v');
      sqliteVersion = String(rows[0]?.values[0]?.[0] ?? '');
    } finally {
      probe.close();
    }
    send({ __pg: true, kind: 'ready', sqliteVersion, wasmSource });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ __pg: true, kind: 'error', message: `SQLite WASM 运行时初始化失败：${message}` });
    send({ __pg: true, kind: 'done', status: 'unavailable' });
  }
}

function execute(msg: SqlRunMessage): void {
  if (!SQL) {
    send({ __pg: true, kind: 'error', message: 'SQLite 引擎未就绪' });
    send({ __pg: true, kind: 'done', status: 'unavailable' });
    return;
  }

  const db = new SQL.Database();
  const encoder = new TextEncoder();
  let bytes = 0;
  let statements = 0;
  let rows = 0;
  let dbBytes = 0;
  let outputLimited = false;
  let rowLimited = false;
  let doneStatus: SqlDoneStatus = 'ok';

  /**
   * 结果行按 64 行批量回传：几千行结果集若每行一次 postMessage 会把主线程打满。
   * 计数按 "行 + \n" 的字节算，与 flush 后 collector 实际收到的字节严格相等，
   * 这样 worker 内部限额和 execute() 的 outputBytes 是同一把尺子，不会错配。
   */
  const pending: string[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    send({ __pg: true, kind: 'out', stream: 'stdout', text: `${pending.join('\n')}\n` });
    pending.length = 0;
  };

  /** 返回 false 表示输出已触顶，调用方必须停止读取结果集。 */
  const emit = (text: string): boolean => {
    const size = encoder.encode(`${text}\n`).length;
    if (bytes + size > msg.outputBytes) {
      outputLimited = true;
      return false;
    }
    bytes += size;
    pending.push(text);
    if (pending.length >= 64) flush();
    return true;
  };

  try {
    // 附加文件是初始化脚本（schema + 数据），结果集一律丢弃，只保留副作用。
    const init = sqlInitScript(msg.files);
    if (init.trim()) {
      for (const stmt of db.iterateStatements(init)) {
        try {
          while (stmt.step()) {
            /* 初始化语句不输出行 */
          }
        } finally {
          stmt.free();
        }
        statements += 1;
      }
    }

    statements: for (const stmt of db.iterateStatements(msg.code)) {
      statements += 1;
      const columns = stmt.getColumnNames();
      try {
        if (columns.length === 0) {
          while (stmt.step()) {
            /* DDL / DML 不产生行 */
          }
          if (!emit(`-- 语句 ${statements} 完成 · 受影响 ${db.getRowsModified()} 行`)) {
            break statements;
          }
        } else {
          if (!emit(formatRow(columns))) break statements;
          if (!emit(formatSeparator(columns.length))) break statements;
          let produced = 0;
          while (stmt.step()) {
            if (rows >= msg.maxRows) {
              rowLimited = true;
              break;
            }
            if (!emit(formatRow(stmt.get().map(formatCell)))) break;
            rows += 1;
            produced += 1;
          }
          if (produced === 0 && !outputLimited && !rowLimited) {
            emit(`(空结果集 · ${columns.join(', ')})`);
          }
        }
      } finally {
        stmt.free();
      }
      if (outputLimited || rowLimited) break;
    }

    // export() 是「能读回字节」的可观察事实：数据库真的建出来了，不是空壳。
    try {
      dbBytes = db.export().length;
    } catch {
      dbBytes = 0;
    }
  } catch (err) {
    flush();
    const message = err instanceof Error ? err.message : String(err);
    doneStatus = classifySqlError(message);
    send({ __pg: true, kind: 'error', message });
  } finally {
    try {
      db.close();
    } catch {
      /* 引擎异常时 close 可能失败，不能让它盖掉真正的错误 */
    }
  }

  if (doneStatus === 'ok' && (outputLimited || rowLimited)) doneStatus = 'output-limit';

  flush();
  send({
    __pg: true,
    kind: 'meta',
    statements: String(statements),
    rows: String(rows),
    dbBytes: String(dbBytes),
    outputLimited: outputLimited ? '1' : '0',
    rowLimited: rowLimited ? '1' : '0',
    memoryCapability: SQL_MEMORY_CAPABILITY,
  });
  send({ __pg: true, kind: 'done', status: doneStatus });
}

scope.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as Partial<SqlRunMessage> | undefined;
  if (data?.__pg === true && data.kind === 'run') {
    execute(data as SqlRunMessage);
  }
});

void boot();
