/**
 * 浏览器内端到端自检（?selftest=1）。
 *
 * 纪律：
 *  1. 判据押「可观察副作用 + 可计数的量」，不押「没抛错」。HTML/CSS 押 probes 里
 *     真实读回的页面文本与 computed style；Lua 押内存用量、wasm URL、Lua 版本号。
 *  2. 跳过必须单独记账：EXPECTED_SKIPS 是硬编码白名单，多跳一条、少跳一条都判红。
 *  3. 结果挂到 window.__PLAYGROUND_SELFTEST__，方便外部脚本直接读，不靠解析页面文字。
 */
import type { BrowserSandbox, LangId, RunLimits, RunRequest, RunResult } from '../core/contract';
import { deriveCapabilities, validateWiring } from '../core/capabilities';
import { execute } from '../core/execute';
import type { RunnerRegistry } from '../core/registry';
import { isSelfHostedWasm } from '../runners/browser/lua-shared';

export type AssertionStatus = 'pass' | 'fail' | 'skip';

export interface Assertion {
  id: string;
  lang: LangId | 'global';
  name: string;
  status: AssertionStatus;
  detail: string;
}

export interface SelftestReport {
  assertions: Assertion[];
  passed: number;
  failed: number;
  skipped: number;
  skipIds: string[];
  ok: boolean;
}

/** 只有这两条允许跳过，且理由必须写清楚。门控自检会核对集合完全相等。 */
const EXPECTED_SKIPS = ['css/infinite-loop', 'html/infinite-loop'];

const FILE_NAMES: Record<LangId, string> = {
  javascript: 'main.js',
  typescript: 'main.ts',
  html: 'index.html',
  css: 'style.css',
  lua: 'main.lua',
};

function fileName(lang: LangId): string {
  return FILE_NAMES[lang];
}

function text(r: RunResult): string {
  return r.outputs.map((o) => o.text).join('\n');
}

function hasStderr(r: RunResult): boolean {
  return r.outputs.some((o) => o.stream === 'stderr' && o.text.trim().length > 0);
}

export async function runSelftest(
  reg: RunnerRegistry,
  limits: RunLimits,
): Promise<SelftestReport> {
  const assertions: Assertion[] = [];

  const pass = (id: string, lang: LangId | 'global', name: string, ok: boolean, detail: string) => {
    assertions.push({ id, lang, name, status: ok ? 'pass' : 'fail', detail });
  };
  const skip = (id: string, lang: LangId, name: string, reason: string) => {
    assertions.push({ id, lang, name, status: 'skip', detail: reason });
  };

  async function run(
    lang: LangId,
    code: string,
    opts: {
      stdin?: string;
      files?: RunRequest['files'];
      sandbox?: BrowserSandbox;
      wallMs?: number;
      memoryBytes?: number;
    } = {},
  ): Promise<RunResult> {
    const req: RunRequest = {
      language: lang,
      files: opts.files ?? [{ name: fileName(lang), content: code }],
      stdin: opts.stdin ?? '',
      limits: {
        ...limits,
        wallMs: opts.wallMs ?? limits.wallMs,
        memoryBytes: opts.memoryBytes ?? limits.memoryBytes,
      },
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    };
    return execute(req, reg).result;
  }

  // ---------- 全局：接线真值 ----------
  const caps = deriveCapabilities(reg);
  const wiringProblems = validateWiring(reg, caps);
  pass(
    'global/wiring', 'global', '能力表与注册表一致',
    wiringProblems.length === 0 && caps.every((c) => c.available),
    wiringProblems.join('；') || `5 门语言全部已接线：${caps.map((c) => c.runnerIds.join('+')).join(' / ')}`,
  );

  // ---------- JavaScript（Worker） ----------
  {
    let r = await run('javascript', `console.log('标准输出标记');`);
    pass('js/stdout', 'javascript', 'stdout 回显', text(r).includes('标准输出标记') && r.status === 'ok', `status=${r.status} outputs=${r.outputs.length}`);

    r = await run('javascript', `console.error('错误标记'); throw new Error('刻意报错');`);
    pass('js/stderr', 'javascript', 'stderr + 运行时错误', hasStderr(r) && r.status === 'error', `status=${r.status} stderr=${hasStderr(r)}`);

    r = await run('javascript', `console.log('STDIN:' + stdin);`, { stdin: '输入内容' });
    pass('js/stdin', 'javascript', 'stdin 回读', text(r).includes('STDIN:输入内容'), text(r).slice(0, 120));

    r = await run('javascript', `console.log('中文标记：昆明');`);
    pass('js/utf8', 'javascript', '中文 UTF-8', text(r).includes('中文标记：昆明'), text(r).slice(0, 120));

    r = await run('javascript', `while (true) {}`, { wallMs: 600 });
    pass('js/infinite-loop', 'javascript', '无限循环被终止', r.status === 'timeout' && r.timedOut, `status=${r.status} timedOut=${r.timedOut} ${r.durationMs}ms`);

    r = await run('javascript', `function main() { return { a: 1, b: '二' }; }`);
    pass('js/main-return', 'javascript', 'main() 返回值读回', text(r).includes('main() 返回') && text(r).includes('a: 1'), text(r).slice(0, 160));
  }

  // ---------- TypeScript（Worker） ----------
  {
    let r = await run('typescript', `const n: number = 7; console.log('TS:', n);`);
    pass('ts/stdout', 'typescript', '类型注解转译后 stdout', text(r).includes('TS: 7') && r.status === 'ok', `status=${r.status} ${text(r).slice(0, 120)}`);

    r = await run('typescript', `const x: = 1;`);
    pass('ts/syntax-error', 'typescript', '语法错误被诊断', r.status === 'error' && r.diagnostics.length > 0, `status=${r.status} diags=${r.diagnostics.length}`);

    r = await run('typescript', 'console.log(`合计：${2 + 3}`);');
    pass('ts/utf8', 'typescript', '中文 + 模板串', text(r).includes('合计：5'), text(r).slice(0, 120));

    r = await run('typescript', `console.log('IN:', stdin);`, { stdin: 'TS输入' });
    pass('ts/stdin', 'typescript', 'stdin 回读', text(r).includes('IN: TS输入'), text(r).slice(0, 120));

    r = await run('typescript', `while (true) {}`, { wallMs: 600 });
    pass('ts/infinite-loop', 'typescript', '无限循环被终止', r.status === 'timeout' && r.timedOut, `status=${r.status} timedOut=${r.timedOut} ${r.durationMs}ms`);

    r = await run('typescript', `function main(): string { return 'typescript-ok'; }`);
    pass('ts/main-return', 'typescript', 'main() 返回值读回', text(r).includes('typescript-ok'), text(r).slice(0, 160));
  }

  // ---------- HTML（iframe） ----------
  {
    let r = await run('html', `<h1>页面标题标记</h1>`);
    pass('html/page-text', 'html', '预览可见文本读回', (r.probes?.pageText ?? '').includes('页面标题标记'), `pageText=${r.probes?.pageText ?? ''}`);

    r = await run('html', `<script>console.log('HTML脚本标记');</script>`);
    pass('html/console', 'html', 'inline script 输出回传', text(r).includes('HTML脚本标记'), text(r).slice(0, 160));

    r = await run('html', `<p>中文内容：昆明</p>`);
    pass('html/utf8', 'html', '中文 UTF-8', (r.probes?.pageText ?? '').includes('中文内容：昆明'), `pageText=${r.probes?.pageText ?? ''}`);

    r = await run('html', `<script>throw new Error('刻意异常');</script>`);
    pass('html/script-error', 'html', '脚本错误可观察', hasStderr(r) && r.status === 'error', `status=${r.status} stderr=${hasStderr(r)}`);

    r = await run('html', `<style>h1{color:#ff0000}</style><h1>标题</h1>`);
    pass('html/inline-css', 'html', 'inline CSS 生效（computed）', r.probes?.h1Color === 'rgb(255, 0, 0)', `h1Color=${r.probes?.h1Color ?? ''}`);

    skip(
      'html/infinite-loop', 'html', '无限循环被终止',
      'iframe 内同步死循环会冻结标签页，主线程 setTimeout 未必有机会执行；该模式不做自动判据，需手工验证或后期迁到服务端',
    );
  }

  // ---------- CSS（iframe） ----------
  {
    let r = await run('css', `h1 { color: #00ff00; }`);
    pass('css/computed', 'css', 'CSS 生效（computed）', r.probes?.h1Color === 'rgb(0, 255, 0)', `h1Color=${r.probes?.h1Color ?? ''}`);

    r = await run('css', `h1 { color: #123456; }`, {
      files: [
        { name: 'style.css', content: `h1 { color: #123456; }` },
        { name: 'index.html', content: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><h1>自定义骨架标记</h1></body></html>` },
      ],
    });
    pass('css/custom-skeleton', 'css', '第二文件覆盖内置 HTML 骨架',
      (r.probes?.pageText ?? '').includes('自定义骨架标记') && r.probes?.h1Color === 'rgb(18, 52, 86)',
      `pageText=${r.probes?.pageText ?? ''} h1Color=${r.probes?.h1Color ?? ''}`);

    r = await run('css', `.card { border-left-color: #185fa5; }`);
    pass('css/utf8', 'css', '内置骨架中文可读回', (r.probes?.pageText ?? '').includes('这是一段用于验证 CSS 的示例正文'), `pageText=${r.probes?.pageText ?? ''}`);

    r = await run('css', `h1{color:#ff0000}\n</style><script>console.log('XSS_MARK')</script><style>h1{color:#00ff00}`);
    pass('css/style-escape', 'css', 'style 标签闭合被挡住',
      !text(r).includes('XSS_MARK') && r.status === 'ok',
      `status=${r.status} 输出=${text(r).slice(0, 160)}`);

    r = await run('css', `h1{color:#123456} h1{color:#abcdef}`);
    pass('css/cascade', 'css', '级联后者生效', r.probes?.h1Color === 'rgb(171, 205, 239)', `h1Color=${r.probes?.h1Color ?? ''}`);

    skip('css/infinite-loop', 'css', '无限循环被终止', 'CSS 没有执行阶段，该判据语义不适用');
  }

  // ---------- Lua（wasmoon WASM / module Worker） ----------
  {
    let r = await run('lua', `print('标准输出标记', 42, true)`);
    pass('lua/stdout', 'lua', 'print 多参数按 tab 分隔回传',
      text(r).includes('标准输出标记\t42\ttrue') && r.status === 'ok',
      `status=${r.status} 输出=${JSON.stringify(text(r).slice(0, 160))}`);

    r = await run('lua', `print('中文标记：昆明')`);
    pass('lua/utf8', 'lua', '中文 UTF-8 往返', text(r).includes('中文标记：昆明'), text(r).slice(0, 120));

    r = await run('lua', `print('IN:' .. tostring(io.read()))`, { stdin: '第一行\n第二行' });
    pass('lua/stdin', 'lua', 'io.read 读回注入的 stdin', text(r).includes('IN:第一行'), text(r).slice(0, 160));

    r = await run('lua', `print('N:' .. tostring(io.read('*n') * 2))`, { stdin: '21\n' });
    pass('lua/io-read-number', 'lua', "io.read('*n') 数值转换", text(r).includes('N:42.0') || text(r).includes('N:42'), text(r).slice(0, 160));

    r = await run('lua', `io.write('NO_NEWLINE_MARK')`);
    pass('lua/io-write', 'lua', 'io.write 无换行也不丢输出', text(r).includes('NO_NEWLINE_MARK'), text(r).slice(0, 160));

    r = await run('lua', `print(tostring({x = 1}))`);
    pass('lua/table', 'lua', 'tostring(table) 保持 Lua 语义', text(r).includes('table: '), text(r).slice(0, 160));

    r = await run('lua', `return 'RET_MARK_' .. tostring(2 + 3)`);
    pass('lua/return', 'lua', '顶层 return 标量读回', text(r).includes('RET_MARK_5'), text(r).slice(0, 160));

    const multiMain = `local h = dofile('/helper.lua'); print('MULTI:' .. tostring(h.twice(21)))`;
    r = await run('lua', multiMain, {
      files: [
        { name: 'main.lua', content: multiMain },
        { name: 'helper.lua', content: `return { twice = function(x) return x * 2 end }` },
      ],
    });
    pass('lua/multi-file', 'lua', '第二文件挂到内存 FS 并读回计算结果',
      text(r).includes('MULTI:42') && r.status === 'ok', `status=${r.status} 输出=${text(r).slice(0, 160)}`);

    r = await run('lua', `error('刻意报错标记')`);
    pass('lua/runtime-error', 'lua', '运行时错误可观察',
      r.status === 'error' && hasStderr(r) && text(r).includes('刻意报错标记'),
      `status=${r.status} stderr=${hasStderr(r)}`);

    r = await run('lua', `local t = {} for i = 1, 200000 do t[i] = string.rep('x', 100) end`, {
      memoryBytes: 1024 * 1024,
    });
    pass('lua/memory-limit', 'lua', 'Lua allocator 触顶映射为 memory-limit',
      r.status === 'memory-limit', `status=${r.status} mem=${r.probes?.memoryUsed ?? r.usage?.memoryBytes ?? '无'}`);

    r = await run('lua', `while true do end`, { wallMs: 600 });
    pass('lua/infinite-loop', 'lua', '同步死循环被 Worker 终止',
      r.status === 'timeout' && r.timedOut, `status=${r.status} timedOut=${r.timedOut} ${r.durationMs}ms`);

    r = await run('lua', `print('VERSION:' .. _VERSION)`);
    pass('lua/version', 'lua', 'probes 里读到 Lua 5.4',
      r.probes?.luaVersion === 'Lua 5.4' && text(r).includes('VERSION:Lua 5.4'),
      `luaVersion=${r.probes?.luaVersion ?? ''} 输出=${text(r).slice(0, 120)}`);

    r = await run('lua', `print('WASM 已就绪')`);
    const src = r.probes?.wasmSource ?? '';
    pass('lua/wasm-selfhost', 'lua', 'glue.wasm 同源自托管且内存用量可计数',
      isSelfHostedWasm(src, location.origin) && Number(r.probes?.memoryUsed ?? 0) > 0,
      `wasmSource=${src} memoryUsed=${r.probes?.memoryUsed ?? '无'}`);
  }

  // ---------- 门控自检：跳过必须精确等于白名单 ----------
  const skipIds = assertions.filter((a) => a.status === 'skip').map((a) => a.id).sort();
  const expected = [...EXPECTED_SKIPS].sort();
  pass(
    'gate/skips', 'global', '跳过记账与白名单完全一致',
    JSON.stringify(skipIds) === JSON.stringify(expected),
    `实际=${skipIds.join(',') || '无'} 预期=${expected.join(',')}`,
  );

  const passed = assertions.filter((a) => a.status === 'pass').length;
  const failed = assertions.filter((a) => a.status === 'fail').length;
  const skipped = assertions.filter((a) => a.status === 'skip').length;
  const report: SelftestReport = { assertions, passed, failed, skipped, skipIds, ok: failed === 0 };
  (window as unknown as Record<string, unknown>).__PLAYGROUND_SELFTEST__ = report;
  return report;
}

export function renderReport(report: SelftestReport, el: HTMLElement): void {
  const h = document.createElement('h2');
  h.textContent = '端到端自检结果';
  const sum = document.createElement('div');
  sum.className = `sum ${report.ok ? 'ok' : 'bad'}`;
  sum.textContent = `通过 ${report.passed} · 失败 ${report.failed} · 记账跳过 ${report.skipped} · 共 ${report.assertions.length} 条${report.ok ? ' · 全绿' : ' · 有红'}`;
  const ul = document.createElement('ul');
  for (const a of report.assertions) {
    const li = document.createElement('li');
    li.className = a.status;
    li.textContent = `[${a.status.toUpperCase()}] ${a.id} ${a.name} — ${a.detail}`;
    ul.appendChild(li);
  }
  el.replaceChildren(h, sum, ul);
}
