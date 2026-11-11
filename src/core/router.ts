import type { Capability, ExecTarget, RunRequest, Runner, RunStatus } from './contract';
import { capabilityFor, deriveCapabilities } from './capabilities';
import type { RunnerRegistry } from './registry';

export type Decision =
  | { kind: 'run'; runner: Runner; capability: Capability }
  | { kind: 'refuse'; status: RunStatus; reason: string };

function refuse(status: RunStatus, reason: string): Decision {
  return { kind: 'refuse', status, reason };
}

/**
 * 选择执行后端。三条纪律：
 *  1. 指定了 target 但该语言不支持 ⇒ 明确拒绝，绝不静默降级到另一个后端。
 *  2. enabled=false 的 runner 视同不存在（注册表 active() 已过滤）。
 *  3. 能力表由注册表实时推导，不缓存，避免「接线真值」漂移。
 */
export function resolveRunner(
  req: RunRequest,
  reg: RunnerRegistry,
  caps: readonly Capability[] = deriveCapabilities(reg),
): Decision {
  const cap = capabilityFor(caps, req.language);

  if (!cap.available) {
    return refuse('unsupported', cap.reason ?? `${cap.label} 未接线`);
  }

  const wanted: ExecTarget | null = req.target ?? cap.prefer;
  if (!wanted) {
    return refuse('unsupported', `${cap.label} 没有默认执行位置`);
  }

  if (!cap.targets.includes(wanted)) {
    return refuse(
      'unsupported',
      `${cap.label} 不能在 ${wanted} 执行；当前可用位置：${cap.targets.join(' / ') || '无'}`,
    );
  }

  const pool = reg.active(req.language, wanted);
  const candidates =
    wanted === 'browser' && req.sandbox
      ? pool.filter((r) => r.sandbox === req.sandbox)
      : pool;
  if (pool.length === 0) {
    return refuse('unavailable', `${cap.label} 的 ${wanted} runner 未启用或 run 不是函数`);
  }
  if (candidates.length === 0) {
    return refuse(
      'unavailable',
      `${cap.label} 没有 ${req.sandbox} 载体；可用载体：${pool.map((r) => r.sandbox ?? 'n/a').join(' / ')}`,
    );
  }

  return { kind: 'run', runner: candidates[0], capability: cap };
}
