import { describe, expect, it } from 'vitest';
import { LANG_DEFS, deriveCapabilities, validateWiring, capabilityFor } from '../core/capabilities';
import { RunnerRegistry } from '../core/registry';
import { createRegistry, createLocalRunner, createPistonRunner } from '../runners';
import type { ExecTarget, LangId, RunResult, Runner, TrustLevel } from '../core/contract';
import { newResult } from '../core/result';

function fakeRunner(
  lang: LangId,
  target: ExecTarget = 'browser',
  enabled = true,
  trust: TrustLevel = 'advisory',
): Runner {
  return {
    id: `fake.${lang}.${target}`,
    target,
    languages: [lang],
    enabled,
    isolation: target === 'server' ? 'process-only' : 'browser',
    trust,
    priority: 1,
    async run(): Promise<RunResult> {
      return newResult({ requestId: 'x', language: lang, target, engine: 'fake' });
    },
  };
}

/** 合成注册表用于验证「拆一门只红一门」的推导逻辑。 */
function synthetic(): RunnerRegistry {
  const reg = new RunnerRegistry();
  for (const lang of ['javascript', 'typescript', 'html', 'css', 'lua', 'sql', 'python'] as LangId[]) {
    reg.register(fakeRunner(lang));
  }
  reg.register(fakeRunner('go', 'server'));
  reg.register(fakeRunner('php', 'server'));
  reg.register(fakeRunner('perl', 'server'));
  reg.register(fakeRunner('r', 'server'));
  reg.register(fakeRunner('ruby', 'server'));
  return reg;
}

describe('能力表由接线层推导', () => {
  it('接线真值：浏览器七门已接线；Go / PHP / Perl / R / Ruby 未注入服务端 runner 时如实置灰', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement));
    const caps = deriveCapabilities(reg);
    expect(caps).toHaveLength(LANG_DEFS.length);
    for (const cap of caps) {
      if (cap.lang === 'go' || cap.lang === 'php' || cap.lang === 'perl' || cap.lang === 'r' || cap.lang === 'ruby') {
        expect(cap.available, '纯服务端语言没注入 runner 就不能谎报可用').toBe(false);
        expect(cap.reason).toContain('未接线');
        continue;
      }
      expect(cap.available, `${cap.lang} 应当可用`).toBe(true);
      expect(cap.targets).toEqual(['browser']);
      expect(cap.prefer).toBe('browser');
      expect(cap.offline).toBe(true);
      // 首版没有服务端 runner，不能谎报「结果可判分」
      expect(cap.trusted).toBe(false);
    }
    expect(validateWiring(reg, caps)).toEqual([]);
  });

  it('拆线负例：撤掉一门语言的 runner，只有该门置灰', () => {
    const reg = synthetic();
    const before = deriveCapabilities(reg);
    expect(before.every((c) => c.available)).toBe(true);

    reg.unregister('fake.css.browser');
    const after = deriveCapabilities(reg);
    const off = after.filter((c) => !c.available);
    expect(off.map((c) => c.lang)).toEqual(['css']);
    expect(capabilityFor(after, 'css').reason).toContain('未接线');
    // 押相对数量：再加一门语言时这条不会跟着红，拆线负例仍是「只红一条」。
    expect(after.filter((c) => c.available)).toHaveLength(before.filter((c) => c.available).length - 1);
    expect(validateWiring(reg, after)).toEqual([]);
  });

  it('拆掉 Lua runner，只有 Lua 置灰（WASM 语言按门接线）', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement));
    const before = deriveCapabilities(reg);
    expect(reg.unregister('wasmoon.lua.wasm')).toBe(true);
    const after = deriveCapabilities(reg);

    // 只押「Lua 不可用 + 其余每一门的状态与拆线前逐门相同」。
    // 不押绝对数量、也不押「只有一门置灰」：别的语言若同时被摘，
    // 这两个断言都会跟着红，拆线负例就不再是「只红一条」了。
    expect(capabilityFor(after, 'lua').available).toBe(false);
    expect(capabilityFor(after, 'lua').reason).toContain('未接线');
    for (const b of before) {
      if (b.lang === 'lua') continue;
      expect(capabilityFor(after, b.lang).available, `${b.lang} 不该受 Lua 拆线影响`).toBe(b.available);
    }
    expect(validateWiring(reg, after)).toEqual([]);
  });

  it('拆掉 SQL runner，只有 SQL 置灰（WASM 语言按门接线）', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement));
    const before = deriveCapabilities(reg);
    expect(reg.unregister('sql.js.sqlite.wasm')).toBe(true);
    const after = deriveCapabilities(reg);

    expect(capabilityFor(after, 'sql').available).toBe(false);
    expect(capabilityFor(after, 'sql').reason).toContain('未接线');
    for (const b of before) {
      if (b.lang === 'sql') continue;
      expect(capabilityFor(after, b.lang).available, `${b.lang} 不该受 SQL 拆线影响`).toBe(b.available);
    }
    expect(validateWiring(reg, after)).toEqual([]);
  });

  it('拆掉 Python runner，只有 Python 置灰（WASM 语言按门接线）', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement));
    const before = deriveCapabilities(reg);
    expect(reg.unregister('pyodide.cpython.wasm')).toBe(true);
    const after = deriveCapabilities(reg);

    expect(capabilityFor(after, 'python').available).toBe(false);
    expect(capabilityFor(after, 'python').reason).toContain('未接线');
    for (const b of before) {
      if (b.lang === 'python') continue;
      expect(capabilityFor(after, b.lang).available, `${b.lang} 不该受 Python 拆线影响`).toBe(b.available);
    }
    expect(validateWiring(reg, after)).toEqual([]);
  });

  it('enabled=false 的 runner 视同不存在，不撒谎', () => {
    const reg = new RunnerRegistry();
    reg.register(fakeRunner('javascript', 'browser', false));
    const caps = deriveCapabilities(reg);
    expect(capabilityFor(caps, 'javascript').available).toBe(false);
    expect(validateWiring(reg, caps)).toEqual([]);
  });

  it('run 不是函数的 runner 不算接线', () => {
    const reg = new RunnerRegistry();
    reg.register({ ...fakeRunner('javascript'), run: undefined as unknown as Runner['run'] });
    const caps = deriveCapabilities(reg);
    expect(capabilityFor(caps, 'javascript').available).toBe(false);
    expect(validateWiring(reg, caps)).toEqual([]);
  });

  it('接上 graded 的 server runner 后才报 trusted，且 prefer 仍是 browser', () => {
    const reg = synthetic();
    reg.register(fakeRunner('javascript', 'server', true, 'graded'));
    const cap = capabilityFor(deriveCapabilities(reg), 'javascript');
    expect(cap.targets).toEqual(['browser', 'server']);
    expect(cap.trusted).toBe(true);
    expect(cap.prefer).toBe('browser');
  });

  it('★ 接缝：A′ 是 server 但 advisory，绝不因 target 被误判为可判分', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement), [
      createLocalRunner({ baseUrl: 'http://127.0.0.1:2000' }),
    ]);
    const caps = deriveCapabilities(reg);
    const go = capabilityFor(caps, 'go');
    expect(go.available).toBe(true);
    expect(go.targets).toEqual(['server']);
    expect(go.prefer).toBe('server');
    expect(go.trusted).toBe(false);
    expect(go.trust).toBe('advisory');
    expect(go.isolation).toEqual(['process-only']);
    expect(go.offline).toBe(false);
    // 同一注册表里浏览器七门的信任档不能被服务端 runner 带偏
    expect(capabilityFor(caps, 'javascript').trusted).toBe(false);
    expect(validateWiring(reg, caps)).toEqual([]);
  });

  it('官方 Piston runner 注入后才报 kernel / graded', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement), [
      createPistonRunner({
        baseUrl: 'http://127.0.0.1:2000',
        versions: { go: '1.27.0' },
        timeoutMs: 3000,
        enabled: true,
      }),
    ]);
    const cap = capabilityFor(deriveCapabilities(reg), 'go');
    expect(cap.trusted).toBe(true);
    expect(cap.trust).toBe('graded');
    expect(cap.isolation).toEqual(['kernel']);
  });
});
