import type { Diagnostic, RunContext, RunRequest, RunResult, RunStatus, Runner } from '../../core/contract';
import { newResult, diagnostic } from '../../core/result';
import { isPythonWorkerMessage } from './python-shared';
import type { PythonDoneStatus, PythonWorkerMessage } from './python-shared';

/** 9.6 MB wasm 下载 + 实例化不算用户代码预算，但要兜底，避免资产缺失时永远挂着。 */
const BOOT_TIMEOUT_MS = 45000;

const DONE_STATUS: Readonly<Record<PythonDoneStatus, RunStatus>> = Object.freeze({
  ok: 'ok',
  error: 'error',
  'output-limit': 'output-limit',
  internal: 'internal',
  unavailable: 'unavailable',
});

type Ready = Extract<PythonWorkerMessage, { kind: 'ready' }>;
interface Engine {
  worker: Worker;
  info: Ready;
}

/**
 * 第三门 WASM 语言。与 Lua/SQL 同骨架（module Worker + 自托管 + 两阶段计时），
 * 但有一处结构性差别：**引擎复用**。
 *
 * 每次运行都 new Worker 意味着重新下载并实例化 9.6 MB 的 pyodide.asm.wasm，
 * 十几条端到端判据会直接把自检拖到 90 秒 deadline。所以正常执行完保留 Worker，
 * 靠每次新建的 Python globals 隔离变量；只有超时 / 取消 / 内部错误才
 * terminate 并清空缓存，下次运行重新 boot。
 *
 * 如实登记的边界：sys.modules 在复用期间共享（不是进程级隔离）；
 * 没有 SharedArrayBuffer 中断，同步死循环只能 terminate 真杀；
 * 没有 allocator 上限，usage.memoryBytes 不填，不拿 0 冒充。
 */
export function createPythonRunner(): Runner {
  let engine: Engine | null = null;
  let booting: Promise<Engine> | null = null;
  const live = new Map<string, Worker>();

  function bootEngine(): Promise<Engine> {
    return new Promise<Engine>((resolve, reject) => {
      const worker = new Worker(new URL('./python-worker.ts', import.meta.url), { type: 'module' });
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', onFirst);
        worker.removeEventListener('error', onError);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        reject(new Error(message));
      };
      const onFirst = (ev: MessageEvent<unknown>) => {
        if (settled) return;
        const msg: PythonWorkerMessage | null = isPythonWorkerMessage(ev.data)
          ? (ev.data as PythonWorkerMessage)
          : null;
        if (msg?.kind !== 'ready') {
          fail(msg?.kind === 'error' ? msg.message : 'Pyodide 启动没有返回 ready');
          return;
        }
        settled = true;
        cleanup();
        resolve({ worker, info: msg });
      };
      const onError = (ev: ErrorEvent) => fail(ev.message || 'Pyodide Worker 创建失败');
      const timer = setTimeout(() => {
        fail(
          `Pyodide WASM 在 ${BOOT_TIMEOUT_MS} ms 内没有就绪（检查 public/pyodide/ 是否齐全、indexURL 是否同源）`,
        );
      }, BOOT_TIMEOUT_MS);

      worker.addEventListener('message', onFirst);
      worker.addEventListener('error', onError);
    });
  }

  function getEngine(): Promise<Engine> {
    if (engine) return Promise.resolve(engine);
    if (!booting) {
      booting = bootEngine().then(
        (value) => {
          engine = value;
          booting = null;
          return value;
        },
        (err: unknown) => {
          booting = null;
          throw err;
        },
      );
    }
    return booting;
  }

  return {
    id: 'pyodide.cpython.wasm',
    target: 'browser',
    sandbox: 'worker',
    languages: ['python'],
    enabled: true,
    priority: 10,

    cancel(requestId: string) {
      const worker = live.get(requestId);
      if (!worker) return;
      worker.terminate();
      live.delete(requestId);
      if (engine && engine.worker === worker) engine = null;
    },

    async run(req: RunRequest, ctx: RunContext): Promise<RunResult> {
      const diagnostics: Diagnostic[] = [];
      const startedAt = ctx.now();
      const probes: Record<string, string> = {};

      let active: Engine;
      try {
        active = await getEngine();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return newResult({
          requestId: ctx.requestId,
          language: req.language,
          target: 'browser',
          engine: 'pyodide.cpython.wasm',
          status: 'unavailable',
          diagnostics: [diagnostic('error', reason, 'boot-timeout')],
        });
      }
      if (ctx.signal.aborted) {
        return newResult({
          requestId: ctx.requestId,
          language: req.language,
          target: 'browser',
          engine: 'pyodide.cpython.wasm',
          status: 'error',
          diagnostics: [diagnostic('info', '用户取消执行', 'cancelled')],
        });
      }

      const { worker, info } = active;
      probes.pyodideVersion = info.pyodideVersion;
      probes.pythonVersion = info.pythonVersion;
      probes.indexURL = info.indexURL;
      probes.wasmSource = info.wasmSource;
      probes.stdLibURL = info.stdLibURL;
      probes.lockFileURL = info.lockFileURL;
      probes.packageCapability = info.packageCapability;
      probes.bootMs = info.bootMs;
      live.set(ctx.requestId, worker);

      return new Promise<RunResult>((resolve) => {
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let doneStatus: PythonDoneStatus = 'ok';
        let wallTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (keep: boolean) => {
          if (settled) return;
          settled = true;
          if (wallTimer) clearTimeout(wallTimer);
          ctx.signal.removeEventListener('abort', onAbort);
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onWorkerError);
          live.delete(ctx.requestId);
          if (!keep) {
            worker.terminate();
            if (engine && engine.worker === worker) engine = null;
          }

          if (timedOut) {
            diagnostics.push(
              diagnostic('warning', `超过 ${req.limits.wallMs} ms，CPython Worker 已终止`, 'timeout'),
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
            engine: 'pyodide.cpython.wasm',
            status,
            diagnostics,
          });
          result.timedOut = timedOut;
          result.probes = probes;
          // 没有 allocator 上限，不写 memoryBytes。
          result.usage = { wallMs: Math.max(0, ctx.now() - startedAt) };
          resolve(result);
        };

        const onAbort = () => {
          cancelled = true;
          finish(false);
        };

        const onMessage = (ev: MessageEvent<unknown>) => {
          const msg: PythonWorkerMessage | null = isPythonWorkerMessage(ev.data)
            ? (ev.data as PythonWorkerMessage)
            : null;
          if (!msg) return;
          switch (msg.kind) {
            case 'ready':
              // 已经 boot 完，忽略重复信号；两阶段计时的墙钟不重启。
              break;
            case 'out':
              ctx.emit({ stream: msg.stream, text: msg.text });
              break;
            case 'error':
              diagnostics.push(diagnostic('error', msg.message, 'runtime'));
              ctx.emit({ stream: 'stderr', text: msg.message });
              break;
            case 'meta':
              probes.filesMounted = msg.filesMounted;
              probes.outputLimited = msg.outputLimited;
              probes.engineReused = msg.engineReused;
              probes.returnKind = msg.returnKind;
              if (msg.outputLimited === '1') {
                diagnostics.push(
                  diagnostic('warning', `输出超过 ${req.limits.outputBytes} 字节，已停止回传`, 'output-limit'),
                );
              }
              break;
            case 'done':
              doneStatus = msg.status;
              finish(!timedOut && !cancelled && ['ok', 'error', 'output-limit'].includes(msg.status));
              break;
          }
        };

        const onWorkerError = (ev: ErrorEvent) => {
          diagnostics.push(diagnostic('error', ev.message || 'CPython Worker 执行失败', 'internal'));
          ctx.emit({ stream: 'stderr', text: ev.message || 'CPython Worker 执行失败' });
          doneStatus = 'internal';
          finish(false);
        };

        ctx.signal.addEventListener('abort', onAbort, { once: true });
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onWorkerError);

        wallTimer = setTimeout(() => {
          timedOut = true;
          finish(false);
        }, req.limits.wallMs);

        worker.postMessage({
          __pg: true,
          kind: 'run',
          requestId: ctx.requestId,
          code: req.files[0]?.content ?? '',
          files: req.files,
          stdin: req.stdin ?? '',
          outputBytes: req.limits.outputBytes,
        });
      });
    },
  };
}
