import { describe, expect, it } from 'vitest';
import { buildPistonBody, mapPistonResponse } from '../runners/server/piston';
import type { PistonConfig, PistonResponse } from '../runners/server/piston';
import { DEFAULT_LIMITS } from '../core/limits';
import type { RunRequest } from '../core/contract';

const cfg: PistonConfig = {
  baseUrl: 'http://127.0.0.1:2000',
  versions: { javascript: '20.0.0' },
  timeoutMs: 5000,
};

const req: RunRequest = {
  language: 'javascript',
  files: [{ name: 'main.js', content: `console.log('hi')` }],
  stdin: '输入',
  limits: { ...DEFAULT_LIMITS, wallMs: 1200, cpuMs: 900, memoryBytes: 64 * 1024 * 1024 },
};

function stage(overrides: Partial<PistonResponse['run']> = {}): PistonResponse['run'] {
  return { stdout: '', stderr: '', code: 0, status: null, ...overrides };
}

describe('服务端骨架：RunRequest → Piston v2 body', () => {
  it('内存限额显式传，绝不吃默认的 -1', () => {
    const body = buildPistonBody(req, cfg);
    expect(body.run_memory_limit).toBe(64 * 1024 * 1024);
    expect(body.compile_memory_limit).toBe(64 * 1024 * 1024);
    expect(body.run_memory_limit).not.toBe(-1);
  });

  it('wall / cpu 限额分开传，编译预算与执行预算分开', () => {
    const body = buildPistonBody(req, cfg);
    expect(body.run_timeout).toBe(1200);
    expect(body.run_cpu_time).toBe(900);
    expect(body.compile_timeout).toBe(10000);
  });

  it('files / stdin / language 映射正确', () => {
    const body = buildPistonBody(req, cfg);
    expect(body.language).toBe('javascript');
    expect(body.version).toBe('20.0.0');
    expect(body.stdin).toBe('输入');
    expect(body.files).toEqual([{ name: 'main.js', content: `console.log('hi')` }]);
  });

  it('未登记版本时抛错，不允许发出模糊请求', () => {
    expect(() => buildPistonBody(req, { ...cfg, versions: {} })).toThrow(/未登记/);
  });
});

describe('服务端骨架：六种阶段状态全部有归宿', () => {
  const cases: [string, string][] = [
    ['RE', 'error'],
    ['SG', 'error'],
    ['TO', 'timeout'],
    ['OL', 'output-limit'],
    ['EL', 'output-limit'],
    ['XX', 'internal'],
  ];
  for (const [raw, expected] of cases) {
    it(`${raw} → ${expected}`, () => {
      const r = mapPistonResponse({ run: stage({ status: raw }) }, req, 'r1');
      expect(r.status).toBe(expected);
      expect(r.target).toBe('server');
      expect(r.engine).toBe('piston.v2');
    });
  }

  it('TO 同时置 timedOut', () => {
    const r = mapPistonResponse({ run: stage({ status: 'TO' }) }, req, 'r1');
    expect(r.timedOut).toBe(true);
  });

  it('编译失败优先于运行阶段，且编译输出不丢', () => {
    const r = mapPistonResponse(
      {
        compile: { ...stage(), status: 'RE', stderr: 'syntax error' },
        run: stage({ status: null, code: null }),
      },
      req,
      'r1',
    );
    expect(r.status).toBe('error');
    expect(r.outputs.some((o) => o.text.includes('syntax error'))).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'compile')).toBe(true);
  });

  it('exitCode / usage 从服务端真值映射', () => {
    const r = mapPistonResponse(
      { run: stage({ code: 42, cpu_time: 12, wall_time: 34, memory: 5678 }) },
      req,
      'r1',
    );
    expect(r.exitCode).toBe(42);
    expect(r.usage).toEqual({ cpuMs: 12, wallMs: 34, memoryBytes: 5678 });
  });
});
