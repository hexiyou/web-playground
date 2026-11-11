import type { RunLimits, RunStatus } from './contract';

/**
 * 默认值按「团队内部快速验证片段」定。
 * 注意：这些值必须显式传给服务端后端。Piston 的 run_memory_limit 默认是 -1（无限制），
 * 吃默认值会让一段吃内存的代码打 OOM 整个执行节点，绝不能依赖对方默认。
 */
export const DEFAULT_LIMITS: Readonly<RunLimits> = Object.freeze({
  wallMs: 3000,
  cpuMs: 3000,
  memoryBytes: 256 * 1024 * 1024,
  outputBytes: 64 * 1024,
});

/** Piston / Judge0 的阶段状态 → 统一 RunStatus。六种都要有归宿，别只判 code === 0。 */
export const SERVER_STATUS: Readonly<Record<string, RunStatus>> = Object.freeze({
  RE: 'error',
  SG: 'error',
  TO: 'timeout',
  OL: 'output-limit',
  EL: 'output-limit',
  XX: 'internal',
});

export function mapServerStatus(raw: string | null | undefined): RunStatus {
  if (!raw) return 'ok';
  return SERVER_STATUS[raw] ?? 'internal';
}

const LABELS: Record<RunStatus, string> = {
  ok: '运行完成',
  error: '运行出错',
  timeout: '超时中止',
  'output-limit': '输出超限',
  'memory-limit': '内存超限',
  unsupported: '语言未接线',
  unavailable: '后端不可用',
  internal: '内部错误',
};

export function statusLabel(status: RunStatus): string {
  return LABELS[status];
}

export function isFailure(status: RunStatus): boolean {
  return status !== 'ok';
}
