import type { Diagnostic, RunContext, RunRequest, RunResult, RunStatus, Runner } from '../../core/contract';
import { newResult, diagnostic } from '../../core/result';
import { isSqlWorkerMessage, MAX_SQL_ROWS } from './sql-shared';
import type { SqlDoneStatus, SqlWorkerMessage } from './sql-shared';

/** wasm 下载 + 实例化不算用户代码耗时，但要兜底，避免引擎起不来时永远挂着。 */
const BOOT_TIMEOUT_MS = 20000;

const DONE_STATUS: Readonly<Record<SqlDoneStatus, RunStatus>> = Object.freeze({
  ok: 'ok',
  error: 'error',
  'output-limit': 'output-limit',
  'memory-limit': 'memory-limit',
  internal: 'internal',
  unavailable: 'unavailable',
});

/**
 * 第二门 WASM 语言。与 Lua 同骨架：独立 module Worker（可 terminate 真杀
 * 无限递归 CTE）、wasm 自托管、两阶段计时。差别是结果集逐行回传，且
 * sql.js 没有内存上限 API —— usage.memoryBytes 一律不填，不拿 0 冒充。
 */
export function createSqlRunner(): Runner {
  const live = new Map<string, Worker>();

  return {
    id: 'sql.js.sqlite.wasm',
    target: 'browser',
    sandbox: 'worker',
    languages: ['sql'],
    enabled: true,
    priority: 10,

    cancel(requestId: string) {
      const worker = live.get(requestId);
      if (worker) {
        worker.terminate();
        live.delete(requestId);
      }
    },

    async run(req: RunRequest, ctx: RunContext): Promise<RunResult> {
      const diagnostics: Diagnostic[] = [];
      const startedAt = ctx.now();
      const worker = new Worker(new URL('./sql-worker.ts', import.meta.url), { type: 'module' });
      live.set(ctx.requestId, worker);

      return new Promise<RunResult>((resolve) => {
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let phase: 'boot' | 'running' = 'boot';
        let doneStatus: SqlDoneStatus = 'ok';
        let wallTimer: ReturnType<typeof setTimeout> | undefined;
        let bootTimer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void;
        const probes: Record<string, string> = {};

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(bootTimer);
          if (wallTimer) clearTimeout(wallTimer);
          ctx.signal.removeEventListener('abort', onAbort);
          worker.terminate();
          live.delete(ctx.requestId);

          if (timedOut) {
            diagnostics.push(
              diagnostic('warning', `超过 ${req.limits.wallMs} ms，SQLite Worker 已终止`, 'timeout'),
            );
          }
          if (cancelled) diagnostics.push(diagnostic('info', '用户取消执行', 'cancelled'));

          const status: RunStatus = timedOut
            ? 'timeout'
            : cancelled
              ? 'error'
              : DONE_STATUS[doneStatus];

          const result = newResult({
            requestId: ctx.requestId,
            language: req.language,
            target: 'browser',
            engine: 'sql.js.sqlite.wasm',
            status,
            diagnostics,
          });
          result.timedOut = timedOut;
          result.probes = probes;
          // 没有 allocator 上限就不写 memoryBytes：写 0 等于谎报用量。
          result.usage = { wallMs: Math.max(0, ctx.now() - startedAt) };
          resolve(result);
        };

        onAbort = () => {
          cancelled = true;
          finish();
        };

        bootTimer = setTimeout(() => {
          diagnostics.push(
            diagnostic(
              'error',
              `SQLite WASM 运行时在 ${BOOT_TIMEOUT_MS} ms 内没有就绪（检查 wasm 是否同源可达）`,
              'boot-timeout',
            ),
          );
          doneStatus = 'unavailable';
          finish();
        }, BOOT_TIMEOUT_MS);

        const onMessage = (ev: MessageEvent<unknown>) => {
          const msg: SqlWorkerMessage | null = isSqlWorkerMessage(ev.data)
            ? (ev.data as SqlWorkerMessage)
            : null;
          if (!msg) return;

          switch (msg.kind) {
            case 'ready':
              probes.sqliteVersion = msg.sqliteVersion;
              probes.wasmSource = msg.wasmSource;
              phase = 'running';
              clearTimeout(bootTimer);
              wallTimer = setTimeout(() => {
                timedOut = true;
                finish();
              }, req.limits.wallMs);
              worker.postMessage({
                __pg: true,
                kind: 'run',
                requestId: ctx.requestId,
                code: req.files[0]?.content ?? '',
                files: req.files,
                outputBytes: req.limits.outputBytes,
                maxRows: MAX_SQL_ROWS,
              });
              break;
            case 'out':
              ctx.emit({ stream: msg.stream, text: msg.text });
              break;
            case 'error':
              diagnostics.push(diagnostic('error', msg.message, phase === 'boot' ? 'boot' : 'runtime'));
              ctx.emit({ stream: 'stderr', text: msg.message });
              break;
            case 'meta':
              probes.statements = msg.statements;
              probes.rows = msg.rows;
              probes.dbBytes = msg.dbBytes;
              probes.memoryCapability = msg.memoryCapability;
              probes.outputLimited = msg.outputLimited;
              probes.rowLimited = msg.rowLimited;
              if (msg.outputLimited === '1') {
                diagnostics.push(
                  diagnostic('warning', `结果集超过 ${req.limits.outputBytes} 字节，已停止读取`, 'output-limit'),
                );
              }
              if (msg.rowLimited === '1') {
                diagnostics.push(
                  diagnostic('warning', `结果集超过 ${MAX_SQL_ROWS} 行，已停止读取`, 'row-limit'),
                );
              }
              break;
            case 'done':
              doneStatus = msg.status;
              finish();
              break;
          }
        };

        worker.onmessage = onMessage;
        worker.onerror = (ev) => {
          diagnostics.push(diagnostic('error', ev.message || 'SQLite Worker 创建或执行失败', 'internal'));
          ctx.emit({ stream: 'stderr', text: ev.message || 'SQLite Worker 创建或执行失败' });
          doneStatus = 'internal';
          finish();
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
