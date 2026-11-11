import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, mapServerStatus, statusLabel } from '../core/limits';

describe('限额与状态映射', () => {
  it('默认内存限额是正数，不是 -1', () => {
    expect(DEFAULT_LIMITS.memoryBytes).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.outputBytes).toBeGreaterThan(0);
  });

  it('Piston 六种阶段状态全部映射，未知状态归 internal，空状态归 ok', () => {
    expect(mapServerStatus('RE')).toBe('error');
    expect(mapServerStatus('SG')).toBe('error');
    expect(mapServerStatus('TO')).toBe('timeout');
    expect(mapServerStatus('OL')).toBe('output-limit');
    expect(mapServerStatus('EL')).toBe('output-limit');
    expect(mapServerStatus('XX')).toBe('internal');
    expect(mapServerStatus('ZZ')).toBe('internal');
    expect(mapServerStatus(null)).toBe('ok');
  });

  it('每种状态都有可读文案，不会显示 undefined', () => {
    for (const s of ['ok', 'error', 'timeout', 'output-limit', 'memory-limit', 'unsupported', 'unavailable', 'internal'] as const) {
      expect(statusLabel(s)).not.toContain('undefined');
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
  });
});
