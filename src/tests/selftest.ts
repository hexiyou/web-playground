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
import { deriveCapabilities, validateWiring, capabilityFor } from '../core/capabilities';
import { execute } from '../core/execute';
import type { RunnerRegistry } from '../core/registry';
import { SAMPLES } from '../core/samples';
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
  sql: 'main.sql',
  python: 'main.py',
  go: 'main.go',
  php: 'main.php',
  perl: 'main.pl',
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
      outputBytes?: number;
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
        outputBytes: opts.outputBytes ?? limits.outputBytes,
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
    wiringProblems.join('；') || `${caps.length} 门语言全部已接线：${caps.map((c) => c.runnerIds.join('+')).join(' / ')}`,
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

  // ---------- SQL（sql.js WASM / module Worker） ----------
  {
    let r = await run('sql', `CREATE TABLE t (city TEXT, n INTEGER);
INSERT INTO t VALUES ('昆明', 2), ('昆明', 3), ('成都', 7);
SELECT city, SUM(n) AS total FROM t GROUP BY city ORDER BY total DESC;`);
    pass('sql/multi-statement', 'sql', '多语句共享 DB + 聚合结果读回',
      r.status === 'ok' && text(r).includes('| 成都 | 7 |') && text(r).includes('| 昆明 | 5 |'),
      `status=${r.status} 输出=${JSON.stringify(text(r).slice(0, 200))}`);

    r = await run('sql', `SELECT '中文标记：昆明' AS s;`);
    pass('sql/utf8', 'sql', '中文 UTF-8 往返',
      r.status === 'ok' && text(r).includes('中文标记：昆明'), `status=${r.status} ${text(r).slice(0, 120)}`);

    r = await run('sql', `SELECT NULL AS n, X'0102AB' AS b, 42 AS i;`);
    pass('sql/null-blob', 'sql', 'NULL 与 BLOB 显式可读',
      r.status === 'ok' && text(r).includes('| NULL |') && text(r).includes("X'0102ab'"),
      `status=${r.status} ${text(r).slice(0, 160)}`);

    r = await run('sql', `SELECT sqlite_version() AS v;`);
    pass('sql/version', 'sql', 'probes 里 SQLite 版本与查询值一致',
      /^3\.\d+/.test(r.probes?.sqliteVersion ?? '') && text(r).includes(r.probes?.sqliteVersion ?? '___'),
      `sqliteVersion=${r.probes?.sqliteVersion ?? ''} 输出=${text(r).slice(0, 120)}`);

    r = await run('sql', `CREATE TABLE x (a); INSERT INTO x VALUES (1);`);
    const wasmSrc = r.probes?.wasmSource ?? '';
    pass('sql/wasm-selfhost', 'sql', 'wasm 同源自托管且 DB 字节可计数',
      isSelfHostedWasm(wasmSrc, location.origin) && Number(r.probes?.dbBytes ?? 0) > 0,
      `wasmSource=${wasmSrc} dbBytes=${r.probes?.dbBytes ?? '无'}`);

    const seedMain = `SELECT COUNT(*) AS c, SUM(v) AS s FROM seed;`;
    r = await run('sql', seedMain, {
      files: [
        { name: 'main.sql', content: seedMain },
        { name: 'schema.sql', content: `CREATE TABLE seed (v INTEGER); INSERT INTO seed VALUES (10),(20),(30);` },
      ],
    });
    pass('sql/multi-file', 'sql', '附加 .sql 初始化脚本先执行并读回计算结果',
      r.status === 'ok' && text(r).includes('| 3 | 60 |'),
      `status=${r.status} 输出=${JSON.stringify(text(r).slice(0, 160))}`);

    r = await run('sql', `SELEC * FROM t;`);
    pass('sql/syntax-error', 'sql', '语法错误可观察',
      r.status === 'error' && hasStderr(r) && text(r).includes('syntax error'),
      `status=${r.status} stderr=${hasStderr(r)}`);

    r = await run('sql', `SELECT * FROM 不存在的表;`);
    pass('sql/runtime-error', 'sql', '运行时错误可观察',
      r.status === 'error' && hasStderr(r) && text(r).includes('no such table'),
      `status=${r.status} ${text(r).slice(0, 160)}`);

    r = await run('sql', `CREATE TABLE q (n); INSERT INTO q VALUES (1),(2),(3),(4);`);
    pass('sql/rows-modified', 'sql', 'DML 受影响行数可计数',
      r.status === 'ok' && text(r).includes('受影响 4 行'),
      `status=${r.status} 输出=${JSON.stringify(text(r).slice(0, 160))}`);

    r = await run('sql', `CREATE TABLE e (a); SELECT a FROM e;`);
    pass('sql/empty-result', 'sql', '空结果集有可读回显',
      r.status === 'ok' && text(r).includes('(空结果集'), `status=${r.status} ${text(r).slice(0, 160)}`);

    r = await run(
      'sql',
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 400) SELECT x, '填充填充填充填充填充填充' AS pad FROM c;`,
      { outputBytes: 512 },
    );
    const outRows = Number(r.probes?.rows ?? 0);
    pass('sql/output-limit', 'sql', '输出字节触顶停读（不是事后提示）',
      r.status === 'output-limit' && r.probes?.outputLimited === '1' && outRows > 0 && outRows < 400,
      `status=${r.status} outputLimited=${r.probes?.outputLimited} rows=${outRows}`);

    r = await run(
      'sql',
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 6000) SELECT x FROM c;`,
    );
    const limitedRows = Number(r.probes?.rows ?? 0);
    pass('sql/row-limit', 'sql', '行数护栏触顶停读',
      r.status === 'output-limit' && r.probes?.rowLimited === '1' && limitedRows > 4000 && limitedRows <= 5000,
      `status=${r.status} rowLimited=${r.probes?.rowLimited} rows=${limitedRows}`);

    r = await run('sql', `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT SUM(x) FROM c;`, {
      wallMs: 600,
    });
    pass('sql/infinite-loop', 'sql', '无限递归 CTE 被 Worker 终止',
      r.status === 'timeout' && r.timedOut, `status=${r.status} timedOut=${r.timedOut} ${r.durationMs}ms`);

    r = await run('sql', `SELECT 1;`);
    pass('sql/no-memory-cap', 'sql', '没有 allocator 上限就不谎报内存用量',
      (r.probes?.memoryCapability ?? '').includes('no-allocator-cap') && r.usage?.memoryBytes === undefined,
      `memoryCapability=${r.probes?.memoryCapability ?? ''} usageMemory=${String(r.usage?.memoryBytes)}`);
  }

  // ---------- Python（Pyodide 314.0.7 / CPython 3.14.2 WASM / module Worker） ----------
  {
    let r = await run('python', `print('标准输出标记', 42, True)`);
    pass('python/stdout', 'python', 'print 多参数回传',
      r.status === 'ok' && text(r).includes('标准输出标记 42 True'),
      `status=${r.status} 输出=${JSON.stringify(text(r).slice(0, 160))}`);

    // 引擎复用是可计数的量：第二次运行不该重新下载/实例化 9.6 MB wasm。
    r = await run('python', `print('复用标记')`);
    pass('python/engine-reuse', 'python', '引擎复用，不重下 9.6 MB wasm',
      r.status === 'ok' && r.probes?.engineReused === '1' && text(r).includes('复用标记'),
      `status=${r.status} engineReused=${r.probes?.engineReused ?? '无'} bootMs=${r.probes?.bootMs ?? '无'}`);

    r = await run('python', `print('中文标记：昆明')`);
    pass('python/utf8', 'python', '中文 UTF-8 往返',
      r.status === 'ok' && text(r).includes('中文标记：昆明'), `status=${r.status} ${text(r).slice(0, 120)}`);

    r = await run('python', `import sys\nsys.stderr.write('stderr 标记\\n')`);
    pass('python/stderr', 'python', 'sys.stderr 单独成流',
      r.status === 'ok' && hasStderr(r) && text(r).includes('stderr 标记'),
      `status=${r.status} stderr=${hasStderr(r)}`);

    r = await run('python', `a = input(); b = input(); print('IN:' + a + '/' + b)`, {
      stdin: '第一行\n第二行\n',
    });
    pass('python/stdin', 'python', 'input() 多行读回注入的 stdin',
      r.status === 'ok' && text(r).includes('IN:第一行/第二行'),
      `status=${r.status} 输出=${JSON.stringify(text(r).slice(0, 160))}`);

    r = await run('python', `import json, statistics\nprint('MEAN:' + str(statistics.mean([1, 2, 3])))\nprint(json.dumps({'城市': '昆明'}, ensure_ascii=False))`);
    pass('python/stdlib', 'python', '标准库 import 与中文 JSON',
      r.status === 'ok' && text(r).includes('MEAN:2') && text(r).includes('昆明'),
      `status=${r.status} 输出=${JSON.stringify(text(r).slice(0, 160))}`);

    r = await run('python', `2 + 3`);
    pass('python/return', 'python', '顶层表达式返回值回显',
      r.status === 'ok' && text(r).includes('-- 返回值：5'), `status=${r.status} ${text(r).slice(0, 120)}`);

    const helperMain = `import helper\nprint('MULTI:' + str(helper.twice(21)))`;
    r = await run('python', helperMain, {
      files: [
        { name: 'main.py', content: helperMain },
        { name: 'helper.py', content: `def twice(n):\n    return n * 2\n` },
      ],
    });
    pass('python/multi-file', 'python', '附加 .py 挂内存 FS 并可 import',
      r.status === 'ok' && text(r).includes('MULTI:42') && r.probes?.filesMounted === '1',
      `status=${r.status} filesMounted=${r.probes?.filesMounted ?? '无'} 输出=${JSON.stringify(text(r).slice(0, 160))}`);

    r = await run('python', `def broken(:`);
    pass('python/syntax-error', 'python', '语法错误可观察',
      r.status === 'error' && hasStderr(r), `status=${r.status} stderr=${hasStderr(r)}`);

    r = await run('python', `raise ValueError('刻意报错标记')`);
    pass('python/runtime-error', 'python', '运行时异常带完整 traceback',
      r.status === 'error' && hasStderr(r) && text(r).includes('刻意报错标记'),
      `status=${r.status} stderr=${hasStderr(r)}`);

    // 首版只有标准库。这条押「给一句人话 + 明确不外联」，不是押「没抛错」。
    // 真正的零外联证据在 smoke.mjs 的 CDP 网络守卫里（按已知包仓库域名判红）。
    r = await run('python', `import numpy as np\nprint(np)`);
    const diag = r.diagnostics.map((d) => d.message).join(' | ');
    pass('python/missing-package', 'python', '第三方包给可读错误且不装包',
      r.status === 'error' && diag.includes('numpy') && diag.includes('不会向 CDN'),
      `status=${r.status} 诊断=${diag.slice(0, 180)}`);

    r = await run('python', `print('x' * 100000)`, { outputBytes: 512 });
    pass('python/output-limit', 'python', '输出字节触顶停回传',
      r.status === 'output-limit' && r.probes?.outputLimited === '1',
      `status=${r.status} outputLimited=${r.probes?.outputLimited ?? '无'}`);

    r = await run('python', `import sys\nprint('VERSION:' + sys.version.split()[0])`);
    const wasmSource = r.probes?.wasmSource ?? '';
    const indexURL = r.probes?.indexURL ?? '';
    pass('python/selfhost', 'python', 'core 四件套同源自托管 + 版本/能力如实登记',
      r.probes?.pyodideVersion === '314.0.7' &&
        /^3\.14/.test(r.probes?.pythonVersion ?? '') &&
        isSelfHostedWasm(wasmSource, location.origin) &&
        isSelfHostedWasm(indexURL, location.origin) &&
        (r.probes?.packageCapability ?? '').includes('stdlib-only') &&
        text(r).includes('VERSION:3.14'),
      `ver=${r.probes?.pyodideVersion}/${r.probes?.pythonVersion} wasm=${wasmSource} cap=${(r.probes?.packageCapability ?? '').slice(0, 40)}`);

    // 必须放最后：terminate 会清空复用的引擎，后面的默认示例判据会重新 boot。
    r = await run('python', `while True:\n    pass`, { wallMs: 600 });
    pass('python/infinite-loop', 'python', '同步死循环被 Worker 终止',
      r.status === 'timeout' && r.timedOut, `status=${r.status} timedOut=${r.timedOut} ${r.durationMs}ms`);
  }

  // ---------- Go（A′ 本机进程执行节点 · 仅 server 位置） ----------
  // 纪律：判据押「能读回字节 / status / signal / probes」，绝不押 wall_time 的毫秒数。
  // 本机实测：满 CPU 的 for{} 会让 go build 与 TerminateProcess 各慢约 5 秒，
  // 这是 Windows 环境开销，不是执行节点的超时实现有问题。
  {
    const goCap = capabilityFor(caps, 'go');
    pass('go/wiring', 'go', 'Go 只有 server 位置且不可判分',
      goCap.available && goCap.targets.length === 1 && goCap.targets[0] === 'server' &&
        goCap.prefer === 'server' && !goCap.trusted && goCap.trust === 'advisory' &&
        goCap.isolation.includes('process-only'),
      `targets=${goCap.targets.join('/')} trust=${goCap.trust} isolation=${goCap.isolation.join('/')}`);

    let r = await run('go', `package main\nimport "fmt"\nfunc main() { fmt.Println("GO-STDOUT-MARK") }`);
    pass('go/stdout', 'go', '本地节点 stdout 回显',
      r.status === 'ok' && text(r).includes('GO-STDOUT-MARK'),
      `status=${r.status} out=${text(r).slice(0, 100)}`);
    pass('go/capability', 'go', '如实登记 process-only / advisory / 零外联 / 不谎报内存',
      r.target === 'server' && r.engine === 'local.process.v1' &&
        r.probes?.isolation === 'process-only' && r.probes?.trust === 'advisory' &&
        r.probes?.network === 'GOPROXY=off,GOTOOLCHAIN=local' &&
        r.probes?.stages === 'build+run' && r.usage?.memoryBytes === undefined,
      `engine=${r.engine} probes=${JSON.stringify(r.probes ?? {}).slice(0, 160)} usage=${JSON.stringify(r.usage ?? {})}`);

    r = await run('go',
      `package main\nimport ("bufio"; "fmt"; "os")\nfunc main() { s := bufio.NewScanner(os.Stdin); v := ""; if s.Scan() { v = s.Text() }; fmt.Println("STDIN:", v) }`,
      { stdin: 'marker-42' });
    pass('go/stdin', 'go', 'stdin 注入并读回',
      r.status === 'ok' && text(r).includes('STDIN: marker-42'),
      `status=${r.status} out=${text(r).slice(0, 100)}`);

    r = await run('go',
      `package main\nimport ("fmt"; "os")\nfunc main() { fmt.Fprintln(os.Stderr, "GO-STDERR-MARK"); os.Exit(2) }`);
    pass('go/stderr', 'go', 'stderr 与真实退出码',
      hasStderr(r) && text(r).includes('GO-STDERR-MARK') && r.exitCode === 2,
      `status=${r.status} exitCode=${r.exitCode} stderr=${text(r).slice(0, 100)}`);

    const mainSrc = `package main\nimport "fmt"\nfunc main() { fmt.Println("HELPER:", label()) }`;
    r = await run('go', mainSrc, {
      files: [
        { name: 'main.go', content: mainSrc },
        { name: 'helper.go', content: 'package main\nfunc label() string { return "HELPER-MARK" }\n' },
      ],
    });
    pass('go/multi-file', 'go', '附加 .go 文件同目录参与编译',
      r.status === 'ok' && text(r).includes('HELPER: HELPER-MARK'),
      `status=${r.status} out=${text(r).slice(0, 120)}`);

    r = await run('go', 'package main\nfunc main() { this_is_not_go }');
    pass('go/compile-error', 'go', '编译阶段失败可诊断',
      r.status === 'error' && r.diagnostics.some((d) => d.code === 'compile') &&
        /syntax|expected|undefined/i.test(text(r)),
      `status=${r.status} diag=${r.diagnostics.map((d) => d.code).join('/')} out=${text(r).slice(0, 120)}`);

    // 用 time.Sleep 而不是 for{}：后者在本机会把 kill 拖到 5 秒以上，且判据不押耗时。
    r = await run('go', 'package main\nimport "time"\nfunc main() { time.Sleep(30 * time.Second) }', { wallMs: 700 });
    pass('go/timeout', 'go', '墙钟超时被终止并回报 TO',
      r.status === 'timeout' && r.timedOut &&
        r.diagnostics.some((d) => /TO|超时|终止/.test(d.message)),
      `status=${r.status} timedOut=${r.timedOut} diag=${r.diagnostics.map((d) => d.message).slice(0, 1).join('')}`);

    r = await run('go',
      `package main\nimport "fmt"\nfunc main() { for i := 0; i < 4000; i++ { fmt.Println("012345678901234567890123456789") } }`,
      { outputBytes: 512 });
    pass('go/output-limit', 'go', '输出字节限额生效',
      r.status === 'output-limit' && text(r).length <= 512 + 64,
      `status=${r.status} bytes=${text(r).length}`);

    const escapeSrc = 'package main\nfunc main() {}';
    r = await run('go', escapeSrc, { files: [{ name: '../evil.go', content: escapeSrc }] });
    pass('go/path-escape', 'go', '文件名路径逃逸被节点拒绝',
      r.status === 'unavailable' && r.diagnostics.some((d) => /非法/.test(d.message)),
      `status=${r.status} diag=${r.diagnostics.map((d) => d.message).slice(0, 1).join('')}`);

    r = await run('go', 'package main\nimport "github.com/nope/nope"\nfunc main() {}');
    pass('go/stdlib-only', 'go', '第三方包不可拉取（GOPROXY=off 零外联）',
      r.status !== 'ok' && /GOPROXY|no required module|module lookup disabled|disabled/i.test(text(r)),
      `status=${r.status} out=${text(r).slice(0, 140)}`);
  }

  // ---------- PHP（A′ 本机进程执行节点 · 单阶段解释执行 · 仅 server） ----------
  // 与 Go 互补：第一次真机跑「compile 缺省」分支、单阶段 probes、多语言 runtimes 映射。
  // 判据只押可观察副作用（stdout / stderr / exitCode / probes / status），不押毫秒数。
  {
    const phpCap = capabilityFor(caps, 'php');
    pass('php/wiring', 'php', 'PHP 只有 server 位置且不可判分',
      phpCap.available && phpCap.targets.length === 1 && phpCap.targets[0] === 'server' &&
        phpCap.prefer === 'server' && !phpCap.trusted && phpCap.trust === 'advisory' &&
        phpCap.isolation.includes('process-only'),
      `targets=${phpCap.targets.join('/')} trust=${phpCap.trust} isolation=${phpCap.isolation.join('/')}`);

    let r = await run('php', '<?php echo "PHP-STDOUT-MARK\\n";');
    pass('php/stdout', 'php', '本机 PHP CLI stdout 回显',
      r.status === 'ok' && text(r).includes('PHP-STDOUT-MARK'),
      `status=${r.status} out=${text(r).slice(0, 100)}`);
    pass('php/capability', 'php', '单阶段 / 动态探测来源 / 无内存谎报 / URL 包装器已关',
      r.target === 'server' && r.engine === 'local.process.v1' &&
        r.probes?.stages === 'run' &&
        (r.probes?.runtimePathSource === 'config' || r.probes?.runtimePathSource === 'path') &&
        typeof r.probes?.runtimeVersion === 'string' && r.probes.runtimeVersion.length > 0 &&
        /allow_url_fopen=0/.test(r.probes?.network ?? '') &&
        r.probes?.isolation === 'process-only' && r.probes?.trust === 'advisory' &&
        r.probes?.memoryCapability === 'no-memory-cap' && r.usage?.memoryBytes === undefined,
      `engine=${r.engine} probes=${JSON.stringify(r.probes ?? {}).slice(0, 220)}`);

    r = await run('php', '<?php echo PHP_VERSION;');
    pass('php/version', 'php', 'runtimes 动态探测的版本与解释器自报一致',
      r.status === 'ok' && r.probes?.runtimeVersion === text(r).trim(),
      `reported=${r.probes?.runtimeVersion ?? '无'} self=${text(r).trim().slice(0, 40)}`);

    r = await run('php', '<?php $line = fgets(STDIN); echo "STDIN: " . trim($line === false ? "" : $line);',
      { stdin: 'marker-42' });
    pass('php/stdin', 'php', 'stdin 注入并读回',
      r.status === 'ok' && text(r).includes('STDIN: marker-42'),
      `status=${r.status} out=${text(r).slice(0, 100)}`);

    r = await run('php', '<?php fwrite(STDERR, "PHP-STDERR-MARK\\n"); exit(2);');
    pass('php/stderr', 'php', 'stderr 与真实退出码',
      hasStderr(r) && text(r).includes('PHP-STDERR-MARK') && r.exitCode === 2,
      `status=${r.status} exitCode=${r.exitCode} stderr=${text(r).slice(0, 100)}`);

    r = await run('php',
      '<?php echo "中文标记：昆明\\n"; echo json_encode(["城市" => "昆明"], JSON_UNESCAPED_UNICODE) . "\\n";');
    pass('php/utf8', 'php', '中文 UTF-8 往返与 JSON_UNESCAPED_UNICODE',
      r.status === 'ok' && text(r).includes('中文标记：昆明') && text(r).includes('昆明'),
      `status=${r.status} out=${text(r).slice(0, 120)}`);

    const mainSrc = '<?php require "helper.php"; echo "HELPER: " . phpLabel();';
    r = await run('php', mainSrc, {
      files: [
        { name: 'main.php', content: mainSrc },
        { name: 'helper.php', content: '<?php function phpLabel(): string { return "HELPER-MARK"; }' },
      ],
    });
    pass('php/multi-file', 'php', '附加 .php 文件同目录可 require',
      r.status === 'ok' && text(r).includes('HELPER: HELPER-MARK'),
      `status=${r.status} out=${text(r).slice(0, 120)}`);

    r = await run('php', '<?php echo ;');
    pass('php/syntax-error', 'php', '语法错误进 stderr 且带非零退出码',
      hasStderr(r) && /Parse error|syntax error/i.test(text(r)) && r.exitCode !== 0 && r.exitCode !== null,
      `status=${r.status} exitCode=${r.exitCode} out=${text(r).slice(0, 140)}`);

    r = await run('php', '<?php sleep(30);', { wallMs: 700 });
    pass('php/timeout', 'php', '墙钟超时被终止并回报 TO',
      r.status === 'timeout' && r.timedOut &&
        r.diagnostics.some((d) => /TO|超时|终止/.test(d.message)),
      `status=${r.status} timedOut=${r.timedOut} diag=${r.diagnostics.map((d) => d.message).slice(0, 1).join('')}`);

    r = await run('php',
      '<?php for ($i = 0; $i < 4000; $i++) { echo "012345678901234567890123456789\\n"; }',
      { outputBytes: 512 });
    pass('php/output-limit', 'php', '输出字节限额生效',
      r.status === 'output-limit' && text(r).length <= 512 + 64,
      `status=${r.status} bytes=${text(r).length}`);

    const escapeSrc = '<?php echo 1;';
    r = await run('php', escapeSrc, { files: [{ name: '../evil.php', content: escapeSrc }] });
    pass('php/path-escape', 'php', '文件名路径逃逸被节点拒绝',
      r.status === 'unavailable' && r.diagnostics.some((d) => /非法/.test(d.message)),
      `status=${r.status} diag=${r.diagnostics.map((d) => d.message).slice(0, 1).join('')}`);

    r = await run('php', '<?php var_dump(file_get_contents("http://127.0.0.1:9/nope"));');
    pass('php/url-wrapper', 'php', 'allow_url_fopen=0 真挡住 URL 包装器（不静默放行）',
      hasStderr(r) && /wrapper|allow_url_fopen|failed to open stream/i.test(text(r)) &&
        text(r).includes('bool(false)'),
      `status=${r.status} out=${text(r).slice(0, 180)}`);
  }

  // ---------- Perl（A′ 本机进程执行节点 · 本机挂 Cygwin Perl · 仅 server） ----------
  // 这一组除了常规接线判据，还把 v0.7 实测到的四条 Cygwin / Perl 坑做成可执行证据：
  // UTF-8 编码层陷阱、$^O/cwd/路径分隔符、CRLF、宿主 PATH 无 cygwin 仍能起 shell。
  // ★ 宿主风味不硬编码：runtimeFlavor 由节点探测 $^O 得到，判据让解释器再自报一次核对，
  //   换 Strawberry / ActivePerl / Linux perl 时这组判据不会误红。
  {
    const perlCap = capabilityFor(caps, 'perl');
    pass('perl/wiring', 'perl', 'Perl 只有 server 位置且不可判分',
      perlCap.available && perlCap.targets.length === 1 && perlCap.targets[0] === 'server' &&
        perlCap.prefer === 'server' && !perlCap.trusted && perlCap.trust === 'advisory' &&
        perlCap.isolation.includes('process-only'),
      `targets=${perlCap.targets.join('/')} trust=${perlCap.trust} isolation=${perlCap.isolation.join('/')}`);

    let r = await run('perl', 'print "PERL-STDOUT-MARK\\n";');
    pass('perl/stdout', 'perl', '本机 Perl stdout 回显',
      r.status === 'ok' && text(r).includes('PERL-STDOUT-MARK'),
      `status=${r.status} out=${text(r).slice(0, 100)}`);
    pass('perl/capability', 'perl', '单阶段 / 路径来源 / 宿主风味 / 无内存谎报 / 无网络隔离如实登记',
      r.target === 'server' && r.engine === 'local.process.v1' &&
        r.probes?.stages === 'run' &&
        (r.probes?.runtimePathSource === 'config' || r.probes?.runtimePathSource === 'path') &&
        typeof r.probes?.runtimeVersion === 'string' && r.probes.runtimeVersion.length > 0 &&
        typeof r.probes?.runtimeFlavor === 'string' && r.probes.runtimeFlavor.length > 0 &&
        r.probes?.includePath === '-I.' &&
        /no-enforcement/.test(r.probes?.network ?? '') &&
        r.probes?.memoryCapability === 'no-memory-cap' && r.usage?.memoryBytes === undefined,
      `probes=${JSON.stringify(r.probes ?? {}).slice(0, 240)}`);

    r = await run('perl', 'print "$^O\\n";');
    pass('perl/flavor', 'perl', 'runtimeFlavor 与解释器自报 $^O 一致（不硬编码宿主）',
      r.status === 'ok' && text(r).trim() === r.probes?.runtimeFlavor && text(r).trim().length > 0,
      `flavor=${r.probes?.runtimeFlavor ?? '无'} self=${text(r).trim().slice(0, 40)}`);

    r = await run('perl', 'printf "%s\\n", $^V;');
    pass('perl/version', 'perl', 'runtimes 动态探测的版本与 $^V 自报一致',
      r.status === 'ok' && text(r).includes(String(r.probes?.runtimeVersion ?? '不可能匹配')),
      `reported=${r.probes?.runtimeVersion ?? '无'} self=${text(r).trim().slice(0, 40)}`);

    r = await run('perl', 'my $x=<STDIN>; chomp $x; print "STDIN: $x\\n";', { stdin: 'marker-42' });
    pass('perl/stdin', 'perl', 'stdin 注入并读回',
      r.status === 'ok' && text(r).includes('STDIN: marker-42'),
      `status=${r.status} out=${text(r).slice(0, 100)}`);

    r = await run('perl', 'print STDERR "PERL-STDERR-MARK\\n"; exit 2;');
    pass('perl/stderr', 'perl', 'stderr 与真实退出码',
      hasStderr(r) && text(r).includes('PERL-STDERR-MARK') && r.exitCode === 2,
      `status=${r.status} exitCode=${r.exitCode} stderr=${text(r).slice(0, 100)}`);

    // 中文正确写法：use utf8 让源码字面量成为字符，:encoding(UTF-8) 负责输出编码。
    const goodUtf8 = 'use utf8; binmode(STDOUT, ":encoding(UTF-8)"); print "中文标记：昆明\\n";';
    r = await run('perl', goodUtf8);
    pass('perl/utf8', 'perl', '中文 UTF-8 往返（use utf8 + :encoding(UTF-8)）',
      r.status === 'ok' && text(r).includes('中文标记：昆明'),
      `status=${r.status} out=${text(r).slice(0, 120)}`);

    // ★ 坑的可执行证据：只写 binmode ':utf8' 而没有 use utf8，Perl 把 UTF-8 字节串
    //   当 Latin-1 字符再编码一次 ⇒ 中文变 mojibake。押「两种写法结果不同」，
    //   不押具体乱码字节（跨版本稳定）。
    const trap = await run('perl', 'binmode(STDOUT, ":utf8"); print "中文标记：昆明\\n";');
    pass('perl/utf8-layer-trap', 'perl', 'binmode(:utf8) 缺 use utf8 会乱码（坑已复现并钉死）',
      text(r).includes('中文标记：昆明') && !text(trap).includes('中文标记：昆明'),
      `good=${text(r).trim().slice(0, 40)} trap=${text(trap).trim().slice(0, 60)}`);

    const mainSrc = "require 'helper.pl'; print 'HELPER: ', label(), \"\\n\";";
    r = await run('perl', mainSrc, {
      files: [
        { name: 'main.pl', content: mainSrc },
        { name: 'helper.pl', content: 'sub label { "HELPER-MARK" } 1;' },
      ],
    });
    pass('perl/multi-file', 'perl', '附加 .pl 文件同目录可 require（节点 -I. 生效）',
      r.status === 'ok' && text(r).includes('HELPER: HELPER-MARK'),
      `status=${r.status} out=${text(r).slice(0, 120)}`);

    // Cygwin 专属语义按 flavor 分叉：本机挂 Cygwin 时押 /cygdrive/ 与 / 分隔符；
    // 换原生 Windows Perl 时只押「$O 与 flavor 一致 + cwd 非空」，不误红。
    r = await run('perl', 'use Cwd; use File::Spec; print "OS=$^O\\nCWD=", getcwd(), "\\nSEP=", File::Spec->catfile("a", "b"), "\\n";');
    const out = text(r);
    const flavor = String(r.probes?.runtimeFlavor ?? '');
    const cygwinOk = /OS=cygwin/.test(out) && /CWD=\/cygdrive\//.test(out) && /SEP=a\/b/.test(out);
    const genericOk = out.includes('OS=' + flavor) && /CWD=./.test(out);
    pass('perl/cygwin-semantics', 'perl', '宿主风味对应的路径语义（$O / cwd / 分隔符）',
      r.status === 'ok' && (flavor === 'cygwin' ? cygwinOk : genericOk),
      `flavor=${flavor} out=${out.replace(/\n/g, ' | ').slice(0, 160)}`);

    r = await run('perl', 'print "A\\nB\\n";');
    pass('perl/crlf', 'perl', '输出保持 LF，Cygwin 未把 \\n 转成 CRLF',
      r.status === 'ok' && text(r).includes('A\nB') && !text(r).includes('\r'),
      `status=${r.status} out=${JSON.stringify(text(r)).slice(0, 80)}`);

    // ★ 反直觉：宿主 PATH 里没有 cygwin64，Cygwin 运行时仍自补 /usr/bin 让 shell 可用。
    //   所以节点不必为了便携式 Perl 去改 PATH；但要如实知道这层「隐式环境」存在。
    r = await run('perl', 'my $o = `echo PERL-SH-OK`; chomp $o; print "backtick=$o\\n";');
    pass('perl/backtick', 'perl', '子进程 /bin/sh 可用（Cygwin 运行时自补 PATH）',
      r.status === 'ok' && text(r).includes('backtick=PERL-SH-OK'),
      `status=${r.status} out=${text(r).slice(0, 120)}`);

    r = await run('perl', `use IO::Socket::INET; my $s = IO::Socket::INET->new(Proto => 'udp'); print defined($s) ? 'SOCKET-OK' : 'SOCKET-FAIL'; print "\\n";`);
    pass('perl/socket', 'perl', 'socket 可创建 ⇒ 如实登记「无内核级禁网」',
      r.status === 'ok' && text(r).includes('SOCKET-OK') && /no-enforcement/.test(r.probes?.network ?? ''),
      `status=${r.status} out=${text(r).slice(0, 80)} probes.network=${r.probes?.network ?? '无'}`);

    r = await run('perl', 'my $x = ;');
    pass('perl/syntax-error', 'perl', '语法错误进 stderr 且带非零退出码',
      hasStderr(r) && /syntax error/i.test(text(r)) && r.exitCode !== 0 && r.exitCode !== null,
      `status=${r.status} exitCode=${r.exitCode} out=${text(r).slice(0, 140)}`);

    r = await run('perl', 'sleep(30);', { wallMs: 700 });
    pass('perl/timeout', 'perl', '墙钟超时被终止并回报 TO',
      r.status === 'timeout' && r.timedOut &&
        r.diagnostics.some((d) => /TO|超时|终止/.test(d.message)),
      `status=${r.status} timedOut=${r.timedOut} diag=${r.diagnostics.map((d) => d.message).slice(0, 1).join('')}`);

    r = await run('perl', 'for (1..4000) { print "012345678901234567890123456789\\n" }', { outputBytes: 512 });
    pass('perl/output-limit', 'perl', '输出字节限额生效',
      r.status === 'output-limit' && text(r).length <= 512 + 64,
      `status=${r.status} bytes=${text(r).length}`);

    const escapeSrc = 'print 1;';
    r = await run('perl', escapeSrc, { files: [{ name: '../evil.pl', content: escapeSrc }] });
    pass('perl/path-escape', 'perl', '文件名路径逃逸被节点拒绝',
      r.status === 'unavailable' && r.diagnostics.some((d) => /非法/.test(d.message)),
      `status=${r.status} diag=${r.diagnostics.map((d) => d.message).slice(0, 1).join('')}`);
  }

  // ---------- 默认示例：用户打开页面点「运行」看到的第一份代码 ----------
  // 上面每门语言的判据都用自检自己造的干净输入，天生抓不到「SAMPLES 里那份示例
  // 本身写错了」。v0.3 就踩过：SQL 示例拿 SQLite 保留字 NOTHING 当列别名，
  // 51 绿一条没红，用户一点运行就 syntax error。这里直接跑 SAMPLES 原文，
  // 押「能跑完且没有 error 级诊断」，不押输出字节（免得与 stdout 拆线负例耦合）。
  for (const lang of Object.keys(SAMPLES) as LangId[]) {
    const sample = SAMPLES[lang];
    const r = await run(lang, sample.files[0].content, { files: sample.files });
    const errors = r.diagnostics.filter((d) => d.level === 'error');
    pass(
      `sample/${lang}`,
      lang,
      '默认示例可直接运行',
      r.status === 'ok' && errors.length === 0,
      `status=${r.status} error=${errors.map((d) => d.message).join(' | ') || '无'}`,
    );
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
