import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../core/limits';
import type { LangId, RunContext, RunRequest, RunResult } from '../core/contract';
import { execute } from '../core/execute';
import { createRegistry } from '../runners';
import { createLocalRunner, LOCAL_LANGUAGES, RuntimeCache } from '../runners/server/local';
import { buildExecuteBody, type ServerResponse } from '../runners/server/protocol';

const cfg = { baseUrl: 'http://127.0.0.1:2000', token: 'pg-local-dev-token' };

function request(lang: LangId = 'go', code = 'package main\nfunc main() {}'): RunRequest {
  return {
    language: lang,
    files: [{ name: 'main.go', content: code }],
    stdin: '',
    limits: { ...DEFAULT_LIMITS },
  };
}

function context(): RunContext {
  return {
    requestId: 'r-local-1',
    signal: new AbortController().signal,
    now: () => 0,
    emit: () => undefined,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function goodResponse(): ServerResponse {
  return {
    language: 'go',
    version: '1.27.0',
    run: { stdout: 'GO-OK\n', stderr: '', code: 0, status: null, wall_time: 12 },
    compile: { stdout: '', stderr: '', code: 0, status: null },
    probes: { isolation: 'process-only', trust: 'advisory', stages: 'build+run' },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('A′ 本地执行节点 Runner 元数据', () => {
  it('语言名映射归后端自有，不写进 LANG_DEFS', () => {
    expect(LOCAL_LANGUAGES.go).toBe('go');
    expect(LOCAL_LANGUAGES.php).toBe('php');
    expect(LOCAL_LANGUAGES.r).toBe('r');
    expect(LOCAL_LANGUAGES.sql).toBeUndefined();
  });

  it('登记为 server，如实声明 process-only / advisory', () => {
    const r = createLocalRunner(cfg);
    expect(r.id).toBe('local.process.v1');
    expect(r.target).toBe('server');
    expect(r.enabled).toBe(true);
    // 押「包含」而不是精确数组：再加一门服务端语言时这条判据不该跟着红。
    expect(r.languages).toContain('go');
    expect(r.languages).toContain('php');
    expect(r.languages).toContain('perl');
    expect(r.languages).toContain('r');
    expect(r.isolation).toBe('process-only');
    expect(r.trust).toBe('advisory');
  });

  it('★ Piston v2 兼容子集：限额显式传，output_max_size 是 A′ 扩展字段', () => {
    const body = buildExecuteBody(request(), {
      versions: { go: '1.27.0' },
      languageMap: LOCAL_LANGUAGES,
      compileWallMs: 10_000,
      outputMaxBytes: DEFAULT_LIMITS.outputBytes,
    });
    expect(body.language).toBe('go');
    expect(body.version).toBe('1.27.0');
    expect(body.run_timeout).toBe(DEFAULT_LIMITS.wallMs);
    expect(body.run_memory_limit).toBe(DEFAULT_LIMITS.memoryBytes);
    expect(body.compile_memory_limit).toBe(DEFAULT_LIMITS.memoryBytes);
    expect(body.output_max_size).toBe(DEFAULT_LIMITS.outputBytes);
  });

  it('版本真值来自 /api/v2/runtimes，30 秒内复用不重复探测', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse([{ language: 'go', version: '1.27.0' }]));
    vi.stubGlobal('fetch', fetchMock);
    const cache = new RuntimeCache(30_000);
    const a = await cache.get(cfg.baseUrl, cfg.token, new AbortController().signal);
    const b = await cache.get(cfg.baseUrl, cfg.token, new AbortController().signal);
    expect(a.go).toBe('1.27.0');
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v2/runtimes');
  });

  it('节点不在线时明确 unavailable 并给出启动指引，不吞成 internal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    const r: RunResult = await createLocalRunner(cfg).run(request(), context());
    expect(r.status).toBe('unavailable');
    expect(r.engine).toBe('local.process.v1');
    expect(r.diagnostics[0].message).toContain('npm run server');
  });

  it('节点未登记该语言时不可用，且不静默改跑 browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ language: 'ruby', version: '3.4' }])));
    const r = await createLocalRunner(cfg).run(request(), context());
    expect(r.status).toBe('unavailable');
    expect(r.target).toBe('server');
    expect(r.diagnostics[0].message).toContain('未登记');
  });

  it('Piston v2 响应映射到统一 RunResult，probes 如实带出隔离档', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/runtimes')
        ? jsonResponse([{ language: 'go', version: '1.27.0' }])
        : jsonResponse(goodResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);
    const emitted: { stream: string; text: string }[] = [];
    const ctx = context();
    ctx.emit = (chunk) => { emitted.push(chunk); };
    const r = await createLocalRunner(cfg).run(request(), ctx);
    expect(r.status).toBe('ok');
    expect(r.target).toBe('server');
    expect(r.engine).toBe('local.process.v1');
    expect(r.exitCode).toBe(0);
    // 输出交给 ctx.emit 由 collector 统一编号与限额，runner 不再自己拼 outputs。
    expect(emitted.some((c) => c.stream === 'stdout' && c.text.includes('GO-OK'))).toBe(true);
    expect(r.outputs).toEqual([]);
    expect(r.probes?.isolation).toBe('process-only');
    expect(r.probes?.trust).toBe('advisory');
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, { body: string }];
    const posted = JSON.parse(init.body);
    expect(posted.language).toBe('go');
    expect(posted.run_timeout).toBe(DEFAULT_LIMITS.wallMs);
  });

  it('★ 连线层：经 execute() 后服务端 stdout 真的能读回字节', async () => {
    // 单点调 runner.run() 抓不到这个 bug：pure 函数明明返回了 outputs，
    // 但 execute() 会用 collector.snapshot() 覆盖 runner 的返回值。
    // 只有把「注册表 → 路由 → execute → collector」整条线接起来才看得见。
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/runtimes')
        ? jsonResponse([{ language: 'go', version: '1.27.0' }])
        : jsonResponse(goodResponse()),
    ));
    const reg = createRegistry(() => ({} as unknown as HTMLElement), [createLocalRunner(cfg)]);
    const r = await execute(request(), reg).result;
    expect(r.status).toBe('ok');
    expect(r.target).toBe('server');
    expect(r.outputs.some((o) => o.stream === 'stdout' && o.text.includes('GO-OK'))).toBe(true);
  });

  it('节点返回非 2xx 归为 unavailable，链路失败与执行失败分开', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/runtimes')
        ? jsonResponse([{ language: 'go', version: '1.27.0' }])
        : jsonResponse({ message: 'bad' }, false, 400),
    ));
    const r = await createLocalRunner(cfg).run(request(), context());
    expect(r.status).toBe('unavailable');
    expect(r.diagnostics[0].code).toBe('link');
    expect(r.diagnostics[0].message).toContain('HTTP 400');
  });
});
