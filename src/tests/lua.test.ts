import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../core/limits';
import { LANG_DEFS, capabilityFor, deriveCapabilities, validateWiring } from '../core/capabilities';
import { resolveRunner } from '../core/router';
import type { RunRequest } from '../core/contract';
import { createRegistry } from '../runners';
import {
  LUA_BOOTSTRAP,
  classifyLuaError,
  isSelfHostedWasm,
  luaMountPath,
} from '../runners/browser/lua-shared';

const luaRequest = (over: Partial<RunRequest> = {}): RunRequest => ({
  language: 'lua',
  files: [{ name: 'main.lua', content: `print('ok')` }],
  limits: { ...DEFAULT_LIMITS },
  ...over,
});

describe('Lua 多文件挂载路径：按净结果判逃逸', () => {
  it('普通文件名挂到根', () => {
    expect(luaMountPath('helper.lua')).toBe('/helper.lua');
    expect(luaMountPath('模块.lua')).toBe('/模块.lua');
    expect(luaMountPath('a-b_1.lua')).toBe('/a-b_1.lua');
  });

  it('路径分隔符、父目录跳转、控制字符一律拒绝', () => {
    for (const bad of [
      '../secret.lua', 'a/b.lua', 'a\\b.lua', '..', '.', '', '  ',
      'a/../../b.lua', 'x\0.lua', 'a b.lua', 'a;b.lua',
    ]) {
      expect(luaMountPath(bad), bad).toBeNull();
    }
  });
});

describe('Lua 错误分类与 wasm 自托管判定', () => {
  it('allocator 触顶映射 memory-limit，普通错误仍是 error', () => {
    expect(classifyLuaError('not enough memory')).toBe('memory-limit');
    expect(classifyLuaError('Lua Error(ErrorMem/4): not enough memory')).toBe('memory-limit');
    expect(classifyLuaError('out of memory')).toBe('memory-limit');
    expect(classifyLuaError("[string \"x\"]:1: attempt to call a nil value")).toBe('error');
  });

  it('同源 URL 通过，公共 CDN 一律拒绝', () => {
    const origin = 'http://127.0.0.1:5188';
    expect(isSelfHostedWasm(`${origin}/assets/glue-abc.wasm`, origin)).toBe(true);
    expect(isSelfHostedWasm(`${origin}/node_modules/wasmoon/dist/glue.wasm`, origin)).toBe(true);
    expect(isSelfHostedWasm('https://unpkg.com/wasmoon@1.16.0/dist/glue.wasm', origin)).toBe(false);
    expect(isSelfHostedWasm('https://cdn.jsdelivr.net/npm/wasmoon/dist/glue.wasm', origin)).toBe(false);
    expect(isSelfHostedWasm('https://evil.example/glue.wasm', origin)).toBe(false);
    expect(isSelfHostedWasm('', origin)).toBe(false);
  });
});

describe('Lua bootstrap 接线真值', () => {
  it('四条覆盖都在源码里（单测对没接线天生免疫，这里押具体覆盖点）', () => {
    expect(LUA_BOOTSTRAP).toContain('print = function');
    expect(LUA_BOOTSTRAP).toContain('io.read = function');
    expect(LUA_BOOTSTRAP).toContain('io.write = function');
    expect(LUA_BOOTSTRAP).toContain('__pg_out');
    expect(LUA_BOOTSTRAP).toContain('__pg_err');
    expect(LUA_BOOTSTRAP).toContain("os.exit = function");
    expect(LUA_BOOTSTRAP).toContain("package.path = '/?.lua;'");
    expect(LUA_BOOTSTRAP).toContain("data:find('\\n', pos, true)");
  });
});

describe('Lua runner 元数据与路由', () => {
  it('登记为 browser / worker，且服务端语言名留口', () => {
    const def = LANG_DEFS.find((d) => d.lang === 'lua');
    expect(def?.browserSandbox).toBe('worker');
    expect(def?.switchable).toEqual(['worker']);
    expect(def?.serverLanguage).toBe('lua');
  });

  it('默认路由选中 wasmoon runner；指定 server 明确拒绝，不静默降级', () => {
    const reg = createRegistry(() => ({} as unknown as HTMLElement));
    const caps = deriveCapabilities(reg);
    expect(validateWiring(reg, caps)).toEqual([]);
    expect(capabilityFor(caps, 'lua').available).toBe(true);
    expect(capabilityFor(caps, 'lua').targets).toEqual(['browser']);
    expect(capabilityFor(caps, 'lua').trusted).toBe(false);

    const chosen = resolveRunner(luaRequest(), reg);
    expect(chosen.kind).toBe('run');
    if (chosen.kind === 'run') {
      expect(chosen.runner.id).toBe('wasmoon.lua.wasm');
      expect(chosen.runner.sandbox).toBe('worker');
      expect(chosen.runner.enabled).toBe(true);
      expect(typeof chosen.runner.run).toBe('function');
    }

    const refused = resolveRunner(luaRequest({ target: 'server' }), reg);
    expect(refused.kind).toBe('refuse');
    if (refused.kind === 'refuse') {
      expect(refused.status).toBe('unsupported');
      expect(refused.reason).toContain('不能在 server 执行');
    }
  });
});
