import type { Diagnostic, RunContext, RunRequest, RunResult, RunStatus, Runner } from '../../core/contract';
import { newResult, diagnostic } from '../../core/result';
import { isLuaWorkerMessage } from './lua-shared';
import type { LuaDoneStatus, LuaWorkerMessage } from './lua-shared';

/** wasm 下载 + 实例化不算用户代码耗时，但要兜底，避免引擎起不来时永远挂着。 */
const BOOT_TIMEOUT_MS = 20000;

const DONE_STATUS: Readonly<Record<LuaDoneStatus, RunStatus>> = Object.freeze({
  ok: 'ok',
  error: 'error',
  'memory-limit': 'memory-limit',
  internal: 'internal',
  unavailable: 'unavailable',
});

/**
 * 第一门 WASM 语言。载体是 module Worker（因为要 import wasmoon 这个 UMD 包），
 * 与 JS/TS 的 Blob Worker 不同，但终止手段一致：worker.terminate()。
 *
 * 首屏只多出这个模块的几十行胶水；wasmoon 与 glue.wasm 都在 Worker chunk 里，
 * 只有用户真正运行 Lua 时才会下载 —— 这是「按语言一个个加 WASM」的体积纪律。
 */
export function createLuaRunner(): Runner {
  const live = new Map<string, Worker>();

  return {
    id: 'wasmoon.lua.wasm',
    target: 'browser',
    sandbox: 'worker',
    languages: ['lua'],
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
      const worker = new Worker(new URL('./lua-worker.ts', import.meta.url), { type: 'module' });
      live.set(ctx.requestId, worker);

      return new Promise<RunResult>((resolve) => {
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let phase: 'boot' | 'running' = 'boot';
        let doneStatus: LuaDoneStatus = 'ok';
        let wallTimer: ReturnType<typeof setTimeout> | undefined;
        let bootTimer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void;
        const probes: Record<string, string> = {};
        let memoryUsed = 0;

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(bootTimer);
          if (wallTimer) clearTimeout(wallTimer);
          ctx.signal.removeEventListener('abort', onAbort);
          worker.terminate();
          live.delete(ctx.requestId);

          if (timedOut) diagnostics.push(diagnostic('warning', `超过 ${req.limits.wallMs} ms，Lua Worker 已终止`, 'timeout'));
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
            engine: 'wasmoon.lua.wasm',
            status,
            diagnostics,
          });
          result.timedOut = timedOut;
          result.probes = probes;
          result.usage = { memoryBytes: memoryUsed, wallMs: Math.max(0, ctx.now() - startedAt) };
          resolve(result);
        };

        onAbort = () => {
          cancelled = true;
          finish();
        };

        bootTimer = setTimeout(() => {
          diagnostics.push(
            diagnostic('error', `Lua WASM 运行时在 ${BOOT_TIMEOUT_MS} ms 内没有就绪（检查 glue.wasm 是否同源可达）`, 'boot-timeout'),
          );
          doneStatus = 'unavailable';
          finish();
        }, BOOT_TIMEOUT_MS);

        const onMessage = (ev: MessageEvent<unknown>) => {
          const msg: LuaWorkerMessage | null = isLuaWorkerMessage(ev.data)
            ? (ev.data as LuaWorkerMessage)
            : null;
          if (!msg) return;

          switch (msg.kind) {
            case 'ready':
              probes.luaVersion = msg.luaVersion;
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
                stdin: req.stdin ?? '',
                memoryBytes: req.limits.memoryBytes,
              });
              break;
            case 'out':
              ctx.emit({ stream: msg.stream, text: msg.text });
              break;
            case 'error':
              diagnostics.push(diagnostic('error', msg.message, phase === 'boot' ? 'boot' : 'runtime'));
              ctx.emit({ stream: 'stderr', text: msg.message });
              break;
            case 'meta': {
              const parsed = Number(msg.memoryUsed);
              if (Number.isFinite(parsed)) {
                memoryUsed = parsed;
                probes.memoryUsed = String(parsed);
              }
              break;
            }
            case 'done':
              doneStatus = msg.status;
              finish();
              break;
          }
        };

        worker.onmessage = onMessage;
        worker.onerror = (ev) => {
          diagnostics.push(diagnostic('error', ev.message || 'Lua Worker 创建或执行失败', 'internal'));
          ctx.emit({ stream: 'stderr', text: ev.message || 'Lua Worker 创建或执行失败' });
          doneStatus = 'internal';
          finish();
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
