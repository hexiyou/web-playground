import { describe, expect, it } from 'vitest';
import { deriveCapabilities, validateWiring, capabilityFor } from '../core/capabilities';
import { RunnerRegistry } from '../core/registry';
import { createRegistry } from '../runners';
import type { ExecTarget, LangId, RunResult, Runner } from '../core/contract';
import { newResult } from '../core/result';

function fakeRunner(lang: LangId, target: ExecTarget = 'browser', enabled = true): Runner {
  return {
    id: `fake.${lang}.${target}`,
    target,
    languages: [lang],
    enabled,
    priority: 1,
    async run(): Promise<RunResult> {
      return newResult({ requestId: 'x', language: lang, target, engine: 'fake' });
    },
  };
}

/** 合成注册表用于验证「拆一门只红一门」的推导逻辑。 */
function synthetic(): RunnerRegistry {
  const reg = new RunnerRegistry();
  for (const lang of ['javascript', 'typescript', 'html', 'css'] as LangId[]) {
    reg.register(fakeRunner(lang));
  }
  return reg;
}

describe('能力表由接线层推导', () => {
  it('首版接线真值：四门语言都已接线且只报 browser', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement));
    const caps = deriveCapabilities(reg);
    expect(caps).toHaveLength(4);
    for (const cap of caps) {
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
    expect(after.filter((c) => c.available)).toHaveLength(3);
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

  it('接上 server runner 后才报 trusted，且 prefer 仍是 browser', () => {
    const reg = synthetic();
    reg.register(fakeRunner('javascript', 'server'));
    const cap = capabilityFor(deriveCapabilities(reg), 'javascript');
    expect(cap.targets).toEqual(['browser', 'server']);
    expect(cap.trusted).toBe(true);
    expect(cap.prefer).toBe('browser');
  });
});
