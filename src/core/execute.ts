import type { RunRequest, RunContext, RunResult } from './contract';
import { createCollector } from './collector';
import { newResult, diagnostic } from './result';
import { resolveRunner } from './router';
import type { RunnerRegistry } from './registry';

export interface ExecuteHandle {
  result: Promise<RunResult>;
  cancel(): void;
}

let seq = 0;

function nextId(): string {
  seq += 1;
  return `run-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * 唯一执行入口。公共逻辑（计时、输出限额、错误兜底、取消）全部收口在这里，
 * runner 只负责「把代码跑起来 + 通过 ctx.emit 输出」，不要自己拼 outputs。
 */
export function execute(req: RunRequest, reg: RunnerRegistry): ExecuteHandle {
  const requestId = nextId();
  const controller = new AbortController();
  const collector = createCollector(req.limits.outputBytes);
  const startedAt = Date.now();
  const decision = resolveRunner(req, reg);

  if (decision.kind === 'refuse') {
    const refused = newResult({
      requestId,
      language: req.language,
      target: null,
      engine: null,
      status: decision.status,
      diagnostics: [diagnostic('error', decision.reason, decision.status)],
    });
    return { result: Promise.resolve(refused), cancel: () => undefined };
  }

  const runner = decision.runner;
  const ctx: RunContext = {
    requestId,
    signal: controller.signal,
    now: () => Date.now(),
    emit: (chunk) => collector.emit(chunk),
  };

  const result = runner
    .run(req, ctx)
    .then((partial): RunResult => ({
      ...partial,
      requestId,
      outputs: collector.snapshot(),
      durationMs: Math.max(0, Date.now() - startedAt),
      status: collector.overflow() && partial.status === 'ok' ? 'output-limit' : partial.status,
    }))
    .catch((err: unknown): RunResult => ({
      ...newResult({
        requestId,
        language: req.language,
        target: runner.target,
        engine: runner.id,
        status: 'internal',
        diagnostics: [
          diagnostic('error', `runner 抛出未捕获异常：${err instanceof Error ? err.message : String(err)}`, 'internal'),
        ],
      }),
      outputs: collector.snapshot(),
      durationMs: Math.max(0, Date.now() - startedAt),
    }));

  return {
    result,
    cancel() {
      controller.abort();
      runner.cancel?.(requestId);
    },
  };
}
