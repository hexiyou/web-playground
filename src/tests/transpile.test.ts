import { describe, expect, it } from 'vitest';
import { transpileTypeScript } from '../runners/browser/transpile';

describe('TypeScript 转译', () => {
  it('类型注解被擦除，可执行代码保留', async () => {
    const out = await transpileTypeScript(`const n: number = 7; console.log('TS:', n);`);
    expect(out.diagnostics.filter((d) => d.level === 'error')).toHaveLength(0);
    expect(out.code).not.toContain(': number');
    expect(out.code).toContain('console.log');
    expect(out.code).toContain('TS:');
  });

  it('首版显式拒绝模块导入，不静默生成跑不起来的代码', async () => {
    const out = await transpileTypeScript(`import { x } from 'y'; console.log(x);`);
    expect(out.diagnostics.some((d) => d.code === 'module-unsupported')).toBe(true);
    expect(out.code).toBe('');
  });

  it('语法错误会产出可读诊断', async () => {
    const out = await transpileTypeScript(`const x: = 1;`);
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(out.diagnostics[0].message.length).toBeGreaterThan(0);
  });
});
