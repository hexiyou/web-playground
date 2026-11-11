import { describe, expect, it } from 'vitest';
import { createCollector } from '../core/collector';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('输出收集：按字节限额，不切坏中文', () => {
  it('中文字符串按码点截断，不出现替换字符', () => {
    const c = createCollector(10);
    c.emit({ stream: 'stdout', text: '中文测试内容' });
    const snap = c.snapshot();
    expect(c.overflow()).toBe(true);
    expect(bytes(snap[0].text)).toBeLessThanOrEqual(10);
    expect(snap[0].text).not.toContain('\uFFFD');
    expect(snap.at(-1)?.stream).toBe('info');
    expect(snap.at(-1)?.text).toContain('输出已截断');
  });

  it('超限后不再接收新输出，seq 连续', () => {
    const c = createCollector(4);
    c.emit({ stream: 'stdout', text: 'abcdefgh' });
    c.emit({ stream: 'stdout', text: 'second' });
    const snap = c.snapshot();
    expect(snap.filter((x) => x.stream === 'stdout')).toHaveLength(1);
    expect(snap.map((x) => x.seq)).toEqual([0, 1]);
  });

  it('未超限时字节计数等于实际输出', () => {
    const c = createCollector(1024);
    c.emit({ stream: 'stdout', text: 'abc' });
    c.emit({ stream: 'stderr', text: '昆明' });
    expect(c.overflow()).toBe(false);
    expect(c.bytes()).toBe(bytes('abc') + bytes('昆明'));
    expect(c.snapshot()).toHaveLength(2);
  });
});
