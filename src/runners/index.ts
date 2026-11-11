import { RunnerRegistry } from '../core/registry';
import { createWorkerRunner } from './browser/worker';
import { createIframeRunner } from './browser/iframe';
import { createPistonRunner } from './server/piston';
import type { PistonConfig } from './server/piston';

export { createWorkerRunner } from './browser/worker';
export { createIframeRunner } from './browser/iframe';
export { createPistonRunner, buildPistonBody, mapPistonResponse } from './server/piston';
export type { PistonConfig } from './server/piston';

export interface ServerWiring {
  config: PistonConfig;
  enabled: boolean;
}

/**
 * 首版只注册浏览器 runner。服务端 runner 的工厂和纯函数都已写好，但默认不接线，
 * 这样能力表不会撒谎说 server 可用。后期启用只需传 ServerWiring，UI 一行不改。
 */
export function createRegistry(getMount: () => HTMLElement, server?: ServerWiring): RunnerRegistry {
  const reg = new RunnerRegistry();
  reg.register(createWorkerRunner());
  reg.register(createIframeRunner(getMount));
  if (server?.enabled) {
    reg.register(createPistonRunner({ ...server.config, enabled: true }));
  }
  return reg;
}
