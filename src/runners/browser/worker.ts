import type { Diagnostic, RunContext, RunRequest, RunResult, Runner } from '../../core/contract';
import { newResult, diagnostic } from '../../core/result';
import { transpileTypeScript } from './transpile';

/**
 * Worker 里的桥接脚本。用字符串构造，避免为它单独出一个 worker 产物。
 * postMessage 只能传可结构化克隆的值，所以 console 参数必须先安全序列化。
 */
const WORKER_SOURCE = String.raw`
(function () {
  function safe(v, depth) {
    depth = depth === undefined ? 3 : depth;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
    if (t === 'symbol') return String(v);
    if (depth <= 0) return Array.isArray(v) ? '[Array]' : '[Object]';
    try {
      if (v instanceof Error) return v.name + ': ' + v.message;
      if (Array.isArray(v)) {
        var parts = v.slice(0, 20).map(function (x) { return safe(x, depth - 1); });
        return '[' + parts.join(', ') + (v.length > 20 ? ', \u2026' : '') + ']';
      }
      var keys = Object.keys(v).slice(0, 20);
      return '{' + keys.map(function (k) { return k + ': ' + safe(v[k], depth - 1); }).join(', ') + '}';
    } catch (e) {
      return '[Unserializable]';
    }
  }

  function send(kind, payload) {
    self.postMessage(Object.assign({ __pg: true, kind: kind }, payload || {}));
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (lv) {
    console[lv] = function () {
      var args = Array.prototype.slice.call(arguments);
      var stream = (lv === 'error' || lv === 'warn') ? 'stderr' : 'stdout';
      send('out', { stream: stream, text: args.map(function (a) { return safe(a); }).join(' ') });
    };
  });

  self.addEventListener('error', function (e) {
    send('error', { message: (e && e.message) || String(e.error) });
  });
  self.addEventListener('unhandledrejection', function (e) {
    send('error', { message: '未处理的 Promise 拒绝：' + safe(e.reason) });
  });

  self.addEventListener('message', async function (ev) {
    var data = ev.data || {};
    var code = String(data.code || '');
    var stdin = data.stdin === undefined ? '' : String(data.stdin);
    try {
      var fn = new Function('stdin', '"use strict";\n' + code +
        '\n;return (typeof main === "function") ? main() : undefined;');
      var value = await Promise.resolve(fn(stdin));
      if (value !== undefined) {
        send('out', { stream: 'info', text: '\u21b3 main() 返回：' + safe(value) });
      }
    } catch (err) {
      send('error', { message: (err && err.stack) ? String(err.stack) : String(err) });
    } finally {
      send('done', {});
    }
  });
})();
`;

interface WorkerMessage {
  __pg: true;
  kind: 'out' | 'error' | 'done';
  stream?: 'stdout' | 'stderr' | 'info';
  text?: string;
  message?: string;
}

function isWorkerMessage(v: unknown): v is WorkerMessage {
  return typeof v === 'object' && v !== null && (v as { __pg?: unknown }).__pg === true;
}

async function prepareCode(req: RunRequest): Promise<{ code: string; diagnostics: Diagnostic[]; failed: boolean }> {
  const source = req.files[0]?.content ?? '';
  if (req.language !== 'typescript') return { code: source, diagnostics: [], failed: false };

  const out = await transpileTypeScript(source, req.files[0]?.name ?? 'main.ts');
  const errors = out.diagnostics.filter((d) => d.level === 'error');
  return { code: out.code, diagnostics: out.diagnostics, failed: errors.length > 0 };
}

/** JS/TS 默认载体。同步无限循环可被 worker.terminate() 真杀死 —— 这是选它而不是 iframe 的理由。 */
export function createWorkerRunner(): Runner {
  const live = new Map<string, Worker>();

  return {
    id: 'browser.worker',
    target: 'browser',
    sandbox: 'worker',
    languages: ['javascript', 'typescript'],
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
      const prepared = await prepareCode(req);
      diagnostics.push(...prepared.diagnostics);
      if (prepared.failed) {
        return newResult({
          requestId: ctx.requestId,
          language: req.language,
          target: 'browser',
          engine: 'browser.worker',
          status: 'error',
          diagnostics,
        });
      }

      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      const worker = new Worker(url);
      live.set(ctx.requestId, worker);

      return new Promise<RunResult>((resolve) => {
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let hadError = false;

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          worker.terminate();
          URL.revokeObjectURL(url);
          live.delete(ctx.requestId);

          if (timedOut) diagnostics.push(diagnostic('warning', `超过 ${req.limits.wallMs} ms，Worker 已终止`, 'timeout'));
          if (cancelled) diagnostics.push(diagnostic('info', '用户取消执行', 'cancelled'));

          const status: RunResult['status'] = timedOut
            ? 'timeout'
            : cancelled || hadError
              ? 'error'
              : 'ok';
          const result = newResult({
            requestId: ctx.requestId,
            language: req.language,
            target: 'browser',
            engine: 'browser.worker',
            status,
            diagnostics,
          });
          result.timedOut = timedOut;
          resolve(result);
        };

        const onAbort = () => {
          cancelled = true;
          finish();
        };

        const timer = setTimeout(() => {
          timedOut = true;
          finish();
        }, req.limits.wallMs);

        worker.onmessage = (ev: MessageEvent<unknown>) => {
          const msg = ev.data;
          if (!isWorkerMessage(msg)) return;
          if (msg.kind === 'out') {
            ctx.emit({ stream: msg.stream ?? 'stdout', text: msg.text ?? '' });
          } else if (msg.kind === 'error') {
            hadError = true;
            diagnostics.push(diagnostic('error', msg.message ?? '未知运行时错误', 'runtime'));
            ctx.emit({ stream: 'stderr', text: msg.message ?? '未知运行时错误' });
          } else if (msg.kind === 'done') {
            finish();
          }
        };

        worker.onerror = (ev) => {
          hadError = true;
          ctx.emit({ stream: 'stderr', text: ev.message || 'Worker 创建或执行失败' });
          finish();
        };

        ctx.signal.addEventListener('abort', onAbort, { once: true });
        worker.postMessage({ code: prepared.code, stdin: req.stdin ?? '', requestId: ctx.requestId });
      });
    },
  };
}
