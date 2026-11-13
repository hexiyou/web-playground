/**
 * R / A′ 服务端 Runner 单测层判据。
 *
 * 与真机判据（selftest.ts 的 r/*）分工：这里只押纯函数、映射、档位推导与
 * 「注册表 → execute → collector」连线层；真机才押 Cygwin R 的脚本入口 sh.exe 包装、
 * BASH_FUNC 环境净化、stats 命名空间不谎报这些宿主语义。
 * negative:r 会拆掉 local.process.v1 的 R 接线声明，精确红 3 条。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../core/limits';
import type { LangId, RunContext, RunRequest } from '../core/contract';
import { capabilityFor, deriveCapabilities } from '../core/capabilities';
import { execute } from '../core/execute';
import { createRegistry } from '../runners';
import { createLocalRunner, LOCAL_LANGUAGES, RuntimeCache } from '../runners/server/local';
import { buildExecuteBody, type ServerResponse } from '../runners/server/protocol';

const cfg = { baseUrl: 'http://127.0.0.1:2000', token: 'pg-local-dev-token' };

function request(lang: LangId = 'r', code = 'cat("R-OK\\n");'): RunRequest {
  return {
    language: lang,
    files: [{ name: 'main.R', content: code }],
    stdin: '',
    limits: { ...DEFAULT_LIMITS },
  };
}

function context(): RunContext {
  return {
    requestId: 'r-rlang-1',
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

/** 节点每次 GET 真探测；flavor 是 A′ 扩展字段，由 --version 的 Platform 行解析。 */
function runtimes(): unknown[] {
  return [
    { language: 'go', version: '1.27.0', aliases: ['golang'], source: 'path' },
    { language: 'php', version: '8.0.17', aliases: ['php8'], source: 'config' },
    { language: 'perl', version: '5.32.1', aliases: ['perl5'], source: 'config', flavor: 'cygwin' },
    { language: 'r', version: '4.2.1', aliases: ['rlang', 'rscript'], source: 'config', flavor: 'cygwin' },
  ];
}

function rResponse(): ServerResponse {
  return {
    language: 'r',
    version: '4.2.1',
    // ★ 单阶段语言没有 compile 字段，mapExecuteResponse 必须走 compile 缺省分支。
    run: { stdout: 'R-OK\n', stderr: '', code: 0, status: null, wall_time: 712 },
    probes: {
      isolation: 'process-only',
      trust: 'advisory',
      stages: 'run',
      entryKind: 'shell-script;#!/bin/sh',
      wrapper: 'sh.exe <script>',
      network: 'no-enforcement;serverSocket-available',
      flavorFrom: 'R --version / Platform',
      startupWarning: 'host-specific;stats-namespace-may-be-unavailable',
      runtimePathSource: 'config',
      runtimeVersion: '4.2.1',
      runtimeFlavor: 'cygwin',
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('R / A′ 本机进程执行节点 Runner', () => {
  it('语言名映射归后端自有，R 用本机可执行名 r', () => {
    expect(LOCAL_LANGUAGES.r).toBe('r');
    expect(LOCAL_LANGUAGES.sql).toBeUndefined();
  });

  it('Runner 同时接线 go / php / perl / r，档位仍是 process-only / advisory', () => {
    const r = createLocalRunner(cfg);
    expect(r.id).toBe('local.process.v1');
    expect(r.target).toBe('server');
    expect(r.languages).toContain('go');
    expect(r.languages).toContain('php');
    expect(r.languages).toContain('perl');
    expect(r.languages).toContain('r');
    expect(r.isolation).toBe('process-only');
    expect(r.trust).toBe('advisory');
  });

  it('runtimes 动态探测返回四语言版本，映射只收已登记的后端语言名', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(runtimes()));
    vi.stubGlobal('fetch', fetchMock);
    const cache = new RuntimeCache(30_000);
    const versions = await cache.get(cfg.baseUrl, cfg.token, new AbortController().signal);
    expect(versions.r).toBe('4.2.1');
    expect(versions.go).toBe('1.27.0');
    expect(versions.sql).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Piston v2 body：脚本入口语言也显式传全部限额，output_max_size 是 A′ 扩展', () => {
    const body = buildExecuteBody(request(), {
      versions: { go: '1.27.0', php: '8.0.17', perl: '5.32.1', r: '4.2.1' },
      languageMap: LOCAL_LANGUAGES,
      compileWallMs: 10_000,
      outputMaxBytes: DEFAULT_LIMITS.outputBytes,
    });
    expect(body.language).toBe('r');
    expect(body.version).toBe('4.2.1');
    expect(body.run_timeout).toBe(DEFAULT_LIMITS.wallMs);
    expect(body.run_memory_limit).toBe(DEFAULT_LIMITS.memoryBytes);
    expect(body.compile_memory_limit).toBe(DEFAULT_LIMITS.memoryBytes);
    expect(body.output_max_size).toBe(DEFAULT_LIMITS.outputBytes);
  });

  it('单阶段响应没有 compile，probes 如实登记脚本包装器与宿主风味', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/runtimes') ? jsonResponse(runtimes()) : jsonResponse(rResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);
    const emitted: { stream: string; text: string }[] = [];
    const ctx = context();
    ctx.emit = (chunk) => { emitted.push(chunk); };
    const r = await createLocalRunner(cfg).run(request(), ctx);
    expect(r.status).toBe('ok');
    expect(r.target).toBe('server');
    expect(r.engine).toBe('local.process.v1');
    expect(emitted.some((c) => c.stream === 'stdout' && c.text.includes('R-OK'))).toBe(true);
    expect(r.outputs).toEqual([]);
    expect(r.probes?.stages).toBe('run');
    expect(r.probes?.entryKind).toBe('shell-script;#!/bin/sh');
    expect(r.probes?.wrapper).toBe('sh.exe <script>');
    expect(r.probes?.runtimePathSource).toBe('config');
    expect(r.probes?.runtimeFlavor).toBe('cygwin');
    expect(r.probes?.network).toContain('no-enforcement');
    expect(r.usage?.memoryBytes).toBeUndefined();
  });

  it('★ 连线层：经 execute() 后 R stdout 真的能读回字节', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/runtimes') ? jsonResponse(runtimes()) : jsonResponse(rResponse()),
    ));
    const reg = createRegistry(() => ({} as unknown as HTMLElement), [createLocalRunner(cfg)]);
    const r = await execute(request(), reg).result;
    expect(r.status).toBe('ok');
    expect(r.target).toBe('server');
    expect(r.outputs.some((o) => o.stream === 'stdout' && o.text.includes('R-OK'))).toBe(true);
  });

  it('R 档位：只有 server 位置且 advisory，不因 target 被误判为可判分', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement), [createLocalRunner(cfg)]);
    const r = capabilityFor(deriveCapabilities(reg), 'r');
    expect(r.available).toBe(true);
    expect(r.targets).toEqual(['server']);
    expect(r.prefer).toBe('server');
    expect(r.trusted).toBe(false);
    expect(r.trust).toBe('advisory');
    expect(r.isolation).toEqual(['process-only']);
    expect(r.offline).toBe(false);
  });

  it('节点未登记 r 时 unavailable，给出安装与便携式路径的配置指引', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse([{ language: 'go', version: '1.27.0', source: 'path' }]),
    ));
    const r = await createLocalRunner(cfg).run(request(), context());
    expect(r.status).toBe('unavailable');
    expect(r.target).toBe('server');
    expect(r.diagnostics[0].message).toContain('未登记');
    expect(r.diagnostics[0].message).toContain('runtimes.local.json');
  });
});
