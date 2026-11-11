import { RunnerRegistry } from '../core/registry';
import { createWorkerRunner } from './browser/worker';
import { createIframeRunner } from './browser/iframe';
import { createLuaRunner } from './browser/lua';
import { createPistonRunner } from './server/piston';
import type { PistonConfig } from './server/piston';

export { createWorkerRunner } from './browser/worker';
export { createIframeRunner } from './browser/iframe';
export { createLuaRunner } from './browser/lua';
export { createPistonRunner, buildPistonBody, mapPistonResponse } from './server/piston';
export type { PistonConfig } from './server/piston';

export interface ServerWiring {
  config: PistonConfig;
  enabled: boolean;
}

/**
 * 浏览器 runner 按语言逐个接线：JS/TS → HTML/CSS → Lua(WASM)。
 * 每加一门语言只要在这里 register 一次，能力表自动从「未接线」翻成可用，UI 一行不改。
 * 服务端 runner 的工厂和纯函数都已写好，但默认不接线，这样能力表不会撒谎说 server 可用。
 */
export function createRegistry(getMount: () => HTMLElement, server?: ServerWiring): RunnerRegistry {
  const reg = new RunnerRegistry();
  reg.register(createWorkerRunner());
  reg.register(createIframeRunner(getMount));
  reg.register(createLuaRunner());
  if (server?.enabled) {
    reg.register(createPistonRunner({ ...server.config, enabled: true }));
  }
  return reg;
}
