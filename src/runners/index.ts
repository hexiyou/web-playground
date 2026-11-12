import { RunnerRegistry } from '../core/registry';
import type { Runner } from '../core/contract';
import { createWorkerRunner } from './browser/worker';
import { createIframeRunner } from './browser/iframe';
import { createLuaRunner } from './browser/lua';
import { createSqlRunner } from './browser/sql';
import { createPythonRunner } from './browser/python';
import { createPistonRunner } from './server/piston';
import type { PistonConfig } from './server/piston';
import { createLocalRunner } from './server/local';
import type { LocalConfig } from './server/local';

export { createWorkerRunner } from './browser/worker';
export { createIframeRunner } from './browser/iframe';
export { createLuaRunner } from './browser/lua';
export { createSqlRunner } from './browser/sql';
export { createPythonRunner } from './browser/python';
export { createPistonRunner, buildPistonBody, mapPistonResponse, PISTON_LANGUAGES } from './server/piston';
export type { PistonConfig, PistonStage, PistonResponse } from './server/piston';
export { createLocalRunner, LOCAL_LANGUAGES } from './server/local';
export type { LocalConfig } from './server/local';
export {
  buildExecuteBody,
  mapExecuteResponse,
  emitServerResult,
} from './server/protocol';
export type {
  ServerLanguageMap,
  ServerProtocolConfig,
  ServerResponse,
  ServerStage,
} from './server/protocol';

/**
 * v0.5 抽掉的接缝：不再有 ServerWiring 绑死 PistonConfig。
 * 服务端 runner 由调用方注入实例，A′ 与官方 Piston 都是「传一个 Runner 进去」，
 * 换后端 = 换注入的这一行，注册表与能力表一行不改。
 */
export function createRegistry(
  getMount: () => HTMLElement,
  serverRunners: readonly Runner[] = [],
): RunnerRegistry {
  const reg = new RunnerRegistry();
  reg.register(createWorkerRunner());
  reg.register(createIframeRunner(getMount));
  reg.register(createLuaRunner());
  reg.register(createSqlRunner());
  reg.register(createPythonRunner());
  for (const runner of serverRunners) reg.register(runner);
  return reg;
}

/** 便捷构造：仍然保留可读的配置形态，但只产出 Runner，不再替调用方决定接线。 */
export function localServerRunner(config: LocalConfig): Runner {
  return createLocalRunner(config);
}

export function pistonServerRunner(config: PistonConfig): Runner {
  return createPistonRunner({ ...config, enabled: true });
}
