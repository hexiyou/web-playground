import type { Diagnostic, RunContext, RunRequest, RunResult, Runner } from '../../core/contract';
import { newResult, diagnostic } from '../../core/result';
import { CSS_SKELETON } from '../../core/samples';
import { transpileTypeScript } from './transpile';

/**
 * 注入到预览页的桥接脚本。
 * sandbox="allow-scripts" 不给 allow-same-origin ⇒ iframe 是 opaque origin，
 * targetOrigin 只能用 '*'，父页靠 event.source + requestId 双重校验，绝不靠 event.origin。
 */
const BRIDGE_JS = String.raw`
(function () {
  var RID = __REQUEST_ID__;
  function safe(v, depth) {
    depth = depth === undefined ? 2 : depth;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return String(v);
    if (t === 'function') return '[Function]';
    if (depth <= 0) return '[Object]';
    try {
      if (Array.isArray(v)) return '[' + v.slice(0, 20).map(function (x) { return safe(x, depth - 1); }).join(', ') + ']';
      return '{' + Object.keys(v).slice(0, 20).map(function (k) { return k + ': ' + safe(v[k], depth - 1); }).join(', ') + '}';
    } catch (e) { return '[Unserializable]'; }
  }
  function send(kind, payload) {
    parent.postMessage(Object.assign({ __pg: true, __iframe: true, requestId: RID, kind: kind }, payload || {}), '*');
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (lv) {
    console[lv] = function () {
      var args = Array.prototype.slice.call(arguments);
      send('out', { stream: (lv === 'error' || lv === 'warn') ? 'stderr' : 'stdout',
                    text: args.map(function (a) { return safe(a); }).join(' ') });
    };
  });
  window.addEventListener('error', function (e) {
    send('error', { message: (e && e.message) || '页面脚本错误' });
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    send('error', { message: '未处理的 Promise 拒绝：' + safe(e.reason) });
  });
  function snapshot() {
    var text = '';
    var color = '';
    try {
      text = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
      var h1 = document.querySelector('h1');
      if (h1 && window.getComputedStyle) color = window.getComputedStyle(h1).color;
    } catch (e) { /* opaque origin 下读不到就留空，父页会看到空 probe */ }
    send('snapshot', { text: text, color: color });
    send('done', {});
  }
  if (document.readyState === 'complete') setTimeout(snapshot, 0);
  else window.addEventListener('load', function () { setTimeout(snapshot, 0); });
})();
`;

interface IframeMessage {
  __pg: true;
  __iframe: true;
  requestId: string;
  kind: 'out' | 'error' | 'snapshot' | 'done';
  stream?: 'stdout' | 'stderr' | 'info';
  text?: string;
  message?: string;
  color?: string;
}

function isIframeMessage(v: unknown): v is IframeMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __pg?: unknown }).__pg === true &&
    (v as { __iframe?: unknown }).__iframe === true
  );
}

function injectAfterHead(html: string, injection: string): string {
  const match = /<head[^>]*>/i.exec(html);
  if (!match) return injection + html;
  return html.slice(0, match.index + match[0].length) + injection + html.slice(match.index + match[0].length);
}

async function buildSrcdoc(
  req: RunRequest,
  requestId: string,
): Promise<{ srcdoc: string; diagnostics: Diagnostic[] }> {
  const bridge = '<script>' + BRIDGE_JS.replace('__REQUEST_ID__', JSON.stringify(requestId)) + '</script>';
  const diagnostics: Diagnostic[] = [];

  if (req.language === 'javascript' || req.language === 'typescript') {
    let code = req.files[0]?.content ?? '';
    if (req.language === 'typescript') {
      const out = await transpileTypeScript(code, req.files[0]?.name ?? 'main.ts');
      diagnostics.push(...out.diagnostics);
      if (out.diagnostics.some((d) => d.level === 'error')) {
        return { srcdoc: '', diagnostics };
      }
      code = out.code;
    }
    const safeCode = code.replace(/<\/script/gi, '<\\/script');
    const doc =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>' +
      '<pre id="pg-out"></pre><script>' + safeCode + '</script></body></html>';
    return { srcdoc: injectAfterHead(doc, bridge), diagnostics };
  }

  if (req.language === 'css') {
    const css = req.files[0]?.content ?? '';
    // 防止用户 CSS 里的 </style> 提前闭合标签（这里只做最小转义，不做 HTML 清洗：
    // iframe 是 opaque origin 且无 allow-same-origin，拿不到父页任何东西）
    const safeCss = css.replace(/<\/style/gi, '<\\/style');
    const htmlFile = req.files.find((f) => /\.html?$/i.test(f.name));
    const skeleton = htmlFile?.content ?? CSS_SKELETON;
    const styleTag = '<style>' + safeCss + '</style>';
    const doc = skeleton.includes('<style data-playground-css></style>')
      ? skeleton.replace('<style data-playground-css></style>', styleTag)
      : injectAfterHead(skeleton, styleTag);
    return { srcdoc: injectAfterHead(doc, bridge), diagnostics };
  }

  return { srcdoc: injectAfterHead(req.files[0]?.content ?? '', bridge), diagnostics };
}

/**
 * HTML / CSS 的预览载体，也是 JS/TS 切到 iframe 模式时的载体。
 * 已知边界：iframe 内的同步死循环会冻结标签页，主线程的 setTimeout 未必有机会执行，
 * 所以「无限循环超时」这条判据只对 Worker 语言自动验证（见 selftest 的 SKIPPED 记账）。
 */
export function createIframeRunner(getMount: () => HTMLElement): Runner {
  const live = new Map<string, HTMLIFrameElement>();

  return {
    id: 'browser.iframe',
    target: 'browser',
    sandbox: 'iframe',
    languages: ['html', 'css', 'javascript', 'typescript'],
    enabled: true,
    priority: 20,

    cancel(requestId: string) {
      const frame = live.get(requestId);
      if (frame) {
        frame.remove();
        live.delete(requestId);
      }
    },

    async run(req: RunRequest, ctx: RunContext): Promise<RunResult> {
      const built = await buildSrcdoc(req, ctx.requestId);
      const diagnostics: Diagnostic[] = [...built.diagnostics];
      const srcdoc = built.srcdoc;
      if (!srcdoc) {
        return newResult({
          requestId: ctx.requestId,
          language: req.language,
          target: 'browser',
          engine: 'browser.iframe',
          status: 'error',
          diagnostics,
        });
      }
      const mount = getMount();
      mount.replaceChildren();

      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('title', 'playground preview');
      frame.style.width = '100%';
      frame.style.height = '100%';
      frame.style.border = '0';
      frame.srcdoc = srcdoc;
      live.set(ctx.requestId, frame);
      mount.appendChild(frame);

      return new Promise<RunResult>((resolve) => {
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let hadError = false;
        const probes: Record<string, string> = {};

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          ctx.signal.removeEventListener('abort', onAbort);
          if (timedOut || cancelled || hadError) frame.remove();
          live.delete(ctx.requestId);

          if (timedOut) diagnostics.push(diagnostic('warning', `预览超过 ${req.limits.wallMs} ms，iframe 已重建`, 'timeout'));
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
            engine: 'browser.iframe',
            status,
            diagnostics,
          });
          result.timedOut = timedOut;
          result.probes = probes;
          result.preview = { kind: 'html', srcdoc };
          resolve(result);
        };

        const onAbort = () => {
          cancelled = true;
          finish();
        };

        const onMessage = (ev: MessageEvent<unknown>) => {
          // opaque origin 下 event.origin === 'null' 证明不了任何事，只认 source + requestId
          if (ev.source !== frame.contentWindow) return;
          const msg = ev.data;
          if (!isIframeMessage(msg) || msg.requestId !== ctx.requestId) return;

          if (msg.kind === 'out') {
            ctx.emit({ stream: msg.stream ?? 'stdout', text: msg.text ?? '' });
          } else if (msg.kind === 'error') {
            hadError = true;
            diagnostics.push(diagnostic('error', msg.message ?? '页面脚本错误', 'runtime'));
            ctx.emit({ stream: 'stderr', text: msg.message ?? '页面脚本错误' });
          } else if (msg.kind === 'snapshot') {
            probes.pageText = msg.text ?? '';
            probes.h1Color = msg.color ?? '';
            ctx.emit({ stream: 'info', text: '[页面可见文本] ' + (msg.text ?? '') });
          } else if (msg.kind === 'done') {
            finish();
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          finish();
        }, req.limits.wallMs);

        window.addEventListener('message', onMessage);
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
