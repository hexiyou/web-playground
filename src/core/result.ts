import type { Diagnostic, ExecTarget, LangId, RunResult, RunStatus } from './contract';

export function newResult(init: {
  requestId: string;
  language: LangId;
  target: ExecTarget | null;
  engine: string | null;
  status?: RunStatus;
  diagnostics?: Diagnostic[];
}): RunResult {
  return {
    requestId: init.requestId,
    language: init.language,
    target: init.target,
    engine: init.engine,
    status: init.status ?? 'ok',
    outputs: [],
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    diagnostics: init.diagnostics ?? [],
  };
}

export function diagnostic(
  level: Diagnostic['level'],
  message: string,
  code?: string,
): Diagnostic {
  return code ? { level, message, code } : { level, message };
}
