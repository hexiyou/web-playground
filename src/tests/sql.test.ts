import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../core/limits';
import { LANG_DEFS, capabilityFor, deriveCapabilities, validateWiring } from '../core/capabilities';
import { resolveRunner } from '../core/router';
import type { RunRequest } from '../core/contract';
import { createRegistry } from '../runners';
import {
  MAX_SQL_ROWS,
  SQL_MEMORY_CAPABILITY,
  classifySqlError,
  formatCell,
  formatRow,
  formatSeparator,
  isSelfHostedWasm,
  sqlInitFiles,
  sqlInitScript,
} from '../runners/browser/sql-shared';

const sqlRequest = (over: Partial<RunRequest> = {}): RunRequest => ({
  language: 'sql',
  files: [{ name: 'main.sql', content: 'SELECT 1;' }],
  limits: { ...DEFAULT_LIMITS },
  ...over,
});

describe('SQL 结果集格式化：押「能读回字节」', () => {
  it('NULL / BLOB / 数字 / 中文 / 换行都显式可读', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(undefined)).toBe('NULL');
    expect(formatCell(42)).toBe('42');
    expect(formatCell('中文标记：昆明')).toBe('中文标记：昆明');
    expect(formatCell('a\nb\tc\r')).toBe('a\\nb\\tc');
    expect(formatCell(new Uint8Array([1, 2, 171]))).toBe("X'0102ab'");
    expect(formatCell(new Uint8Array(20).fill(255))).toContain('…');
  });

  it('行与分隔线按列数生成，不做全角宽度对齐', () => {
    expect(formatRow(['city', 'total'])).toBe('| city | total |');
    expect(formatSeparator(2)).toBe('| --- | --- |');
    expect(formatSeparator(0)).toBe('|  |');
  });
});

describe('SQL 错误分类与能力缺口', () => {
  it('WASM 内存增长失败映射 memory-limit，SQL 错误仍是 error', () => {
    expect(classifySqlError('Cannot enlarge memory arrays to size 1GB')).toBe('memory-limit');
    expect(classifySqlError('Aborted(OOM)')).toBe('memory-limit');
    expect(classifySqlError('out of memory')).toBe('memory-limit');
    expect(classifySqlError('near "SELEC": syntax error')).toBe('error');
    expect(classifySqlError('no such table: x')).toBe('error');
  });

  it('没有 allocator 上限 API 这件事必须写成常量，不许悄悄抹掉', () => {
    expect(SQL_MEMORY_CAPABILITY).toContain('no-allocator-cap');
    expect(MAX_SQL_ROWS).toBeGreaterThan(0);
  });

  it('同源 wasm 判据复用 Lua 那轮的规则（不重复实现）', () => {
    const origin = 'http://127.0.0.1:5188';
    expect(isSelfHostedWasm(`${origin}/assets/sql-wasm-browser-abc.wasm`, origin)).toBe(true);
    expect(isSelfHostedWasm('https://cdnjs.cloudflare.com/ajax/libs/sql.js/x.wasm', origin)).toBe(false);
  });
});

describe('SQL 附加文件初始化脚本', () => {
  it('只收第一个之后、内容非空的文件，按顺序拼接', () => {
    const files = [
      { name: 'main.sql', content: 'SELECT * FROM seed;' },
      { name: 'schema.sql', content: 'CREATE TABLE seed (v);' },
      { name: 'empty.sql', content: '   ' },
      { name: 'data.sql', content: 'INSERT INTO seed VALUES (7);' },
    ];
    expect(sqlInitFiles(files).map((f) => f.name)).toEqual(['schema.sql', 'data.sql']);
    const script = sqlInitScript(files);
    expect(script.indexOf('CREATE TABLE seed')).toBeLessThan(script.indexOf('INSERT INTO seed'));
    expect(script).toContain('-- ===== schema.sql =====');
    expect(script).not.toContain('SELECT * FROM seed');
  });
});

describe('SQL runner 元数据与路由', () => {
  it('登记为 browser / worker，服务端语言名留口', () => {
    const def = LANG_DEFS.find((d) => d.lang === 'sql');
    expect(def?.browserSandbox).toBe('worker');
    expect(def?.switchable).toEqual(['worker']);
    expect(def?.serverLanguage).toBe('sqlite3');
  });

  it('默认路由选中 sql.js runner；指定 server 明确拒绝，不静默降级', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement));
    const caps = deriveCapabilities(reg);
    expect(validateWiring(reg, caps)).toEqual([]);
    expect(capabilityFor(caps, 'sql').available).toBe(true);
    expect(capabilityFor(caps, 'sql').targets).toEqual(['browser']);
    expect(capabilityFor(caps, 'sql').trusted).toBe(false);

    const chosen = resolveRunner(sqlRequest(), reg);
    expect(chosen.kind).toBe('run');
    if (chosen.kind === 'run') {
      expect(chosen.runner.id).toBe('sql.js.sqlite.wasm');
      expect(chosen.runner.sandbox).toBe('worker');
      expect(chosen.runner.enabled).toBe(true);
      expect(typeof chosen.runner.run).toBe('function');
    }

    const refused = resolveRunner(sqlRequest({ target: 'server' }), reg);
    expect(refused.kind).toBe('refuse');
    if (refused.kind === 'refuse') {
      expect(refused.status).toBe('unsupported');
      expect(refused.reason).toContain('不能在 server 执行');
    }
  });
});
