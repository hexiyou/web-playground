import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../core/limits';
import { resolveRunner } from '../core/router';
import { createRegistry, createPistonRunner } from '../runners';
import type { LangId, RunRequest } from '../core/contract';

function request(lang: LangId, extra: Partial<RunRequest> = {}): RunRequest {
  return {
    language: lang,
    files: [{ name: 'main.js', content: 'console.log(1)' }],
    limits: { ...DEFAULT_LIMITS },
    ...extra,
  };
}

describe('路由：明确拒绝，不静默降级', () => {
  const reg = createRegistry(() => ({} as unknown as HTMLElement));

  it('JS 默认选 Worker（priority 更小且可 terminate 无限循环）', () => {
    const d = resolveRunner(request('javascript'), reg);
    expect(d.kind).toBe('run');
    if (d.kind === 'run') expect(d.runner.id).toBe('browser.worker');
  });

  it('JS 显式选 iframe 载体能拿到 DOM 载体', () => {
    const d = resolveRunner(request('javascript', { sandbox: 'iframe' }), reg);
    expect(d.kind).toBe('run');
    if (d.kind === 'run') expect(d.runner.id).toBe('browser.iframe');
  });

  it('HTML 只有 iframe，请求 worker 载体被明确拒绝', () => {
    const d = resolveRunner(request('html', { sandbox: 'worker' }), reg);
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.reason).toContain('没有 worker 载体');
  });

  it('首版请求 server 被拒绝，且理由说明可用位置，不偷偷改回 browser', () => {
    const d = resolveRunner(request('javascript', { target: 'server' }), reg);
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') {
      expect(d.status).toBe('unsupported');
      expect(d.reason).toContain('不能在 server 执行');
      expect(d.reason).toContain('browser');
    }
  });

  it('注入 server runner 后同一请求可执行，UI 契约不变', () => {
    const withServer = createRegistry(() => ({} as unknown as HTMLElement), [
      createPistonRunner({
        baseUrl: 'http://127.0.0.1:2000',
        versions: { javascript: '20.0.0' },
        timeoutMs: 5000,
        enabled: true,
      }),
    ]);
    const d = resolveRunner(request('javascript', { target: 'server' }), withServer);
    expect(d.kind).toBe('run');
    if (d.kind === 'run') {
      expect(d.runner.id).toBe('piston.v2');
      expect(d.capability.trusted).toBe(true);
    }
  });
});
