/**
 * 服务端执行后端骨架 —— 为后期迁移预留，首版不接线（enabled=false，且默认不注册）。
 *
 * 为什么现在就写完整：契约里所有与服务端相关的字段（limits、usage、exitCode、阶段状态）
 * 必须首版就有真实实现压着，否则迁移时会发现「字段是留了，但没人会映射」。
 * 这里的可测纯函数就是那个压舱物。
 *
 * 启用前必须满足（见分析手册第十一章）：
 *  - 执行节点与业务/数据库/云凭据隔离；Piston 自身要求 --privileged 容器，
 *    外层应再套 gVisor 或 Firecracker microVM。
 *  - 公共 API 自 2026-02-15 起需授权，商业/个人项目不发证 ⇒ 自建实例。
 *  - 能力表要由 GET /api/v2/runtimes 动态生成，不要手写版本常量。
 */

import type {
  Diagnostic,
  LangId,
  RunContext,
  RunRequest,
  RunResult,
  Runner,
} from '../../core/contract';
import { langDef } from '../../core/capabilities';
import { mapServerStatus } from '../../core/limits';
import { newResult, diagnostic } from '../../core/result';

export interface PistonConfig {
  baseUrl: string;
  token?: string;
  /** language → 已安装版本。真值应来自 GET /api/v2/runtimes */
  versions: Partial<Record<LangId, string>>;
  timeoutMs: number;
  /** 编译预算与执行预算分开，默认给 10s，避免 C++/Rust 首次编译被误杀 */
  compileWallMs?: number;
  enabled?: boolean;
}

export interface PistonStage {
  stdout?: string;
  stderr?: string;
  output?: string;
  code?: number | null;
  signal?: string | null;
  status?: string | null;
  message?: string | null;
  cpu_time?: number;
  wall_time?: number;
  memory?: number;
}

export interface PistonResponse {
  language?: string;
  version?: string;
  run: PistonStage;
  compile?: PistonStage;
}

/** RunRequest → Piston v2 execute body。所有限额显式传，绝不吃对方默认值。 */
export function buildPistonBody(req: RunRequest, cfg: PistonConfig): Record<string, unknown> {
  const def = langDef(req.language);
  const version = cfg.versions[req.language];
  if (!version) {
    throw new Error(`未登记 ${req.language} 的服务端版本；请先读 GET /api/v2/runtimes`);
  }
  return {
    language: def.serverLanguage,
    version,
    files: req.files.map((f) => ({ name: f.name, content: f.content })),
    stdin: req.stdin ?? '',
    args: [],
    compile_timeout: cfg.compileWallMs ?? 10000,
    run_timeout: req.limits.wallMs,
    compile_cpu_time: req.limits.cpuMs,
    run_cpu_time: req.limits.cpuMs,
    // Piston 的这两个默认值是 -1（无限制）。不显式传 = 把执行节点交给用户代码。
    compile_memory_limit: req.limits.memoryBytes,
    run_memory_limit: req.limits.memoryBytes,
  };
}

/** Piston 阶段状态 → 统一 RunResult。六种状态都有归宿。 */
export function mapPistonResponse(
  resp: PistonResponse,
  req: RunRequest,
  requestId: string,
): RunResult {
  const compileStatus = mapServerStatus(resp.compile?.status);
  const runStatus = mapServerStatus(resp.run.status);
  const compileFailed = compileStatus !== 'ok';
  const status = compileFailed ? compileStatus : runStatus;

  const chunks: RunResult['outputs'] = [];
  const push = (stream: 'stdout' | 'stderr' | 'info', text: string | undefined) => {
    if (!text) return;
    chunks.push({ stream, text, seq: chunks.length });
  };

  if (resp.compile) {
    push('info', '[compile]');
    push('stdout', resp.compile.stdout);
    push('stderr', resp.compile.stderr);
    if (resp.compile.message) push('stderr', resp.compile.message);
  }
  push('stdout', resp.run.stdout);
  push('stderr', resp.run.stderr);
  if (resp.run.message) push('stderr', resp.run.message);

  const diagnostics: Diagnostic[] = [];
  if (compileFailed) {
    diagnostics.push(diagnostic('error', `编译阶段失败：${resp.compile?.status ?? 'unknown'}`, 'compile'));
  }
  if (runStatus !== 'ok') {
    diagnostics.push(diagnostic('error', `运行阶段状态：${resp.run.status ?? 'unknown'}`, 'run'));
  }

  return {
    ...newResult({
      requestId,
      language: req.language,
      target: 'server',
      engine: 'piston.v2',
      status,
      diagnostics,
    }),
    outputs: chunks,
    exitCode: resp.run.code ?? null,
    timedOut: status === 'timeout',
    usage: {
      cpuMs: resp.run.cpu_time,
      wallMs: resp.run.wall_time,
      memoryBytes: resp.run.memory,
    },
  };
}

export function createPistonRunner(cfg: PistonConfig): Runner {
  return {
    id: 'piston.v2',
    target: 'server',
    languages: ['javascript', 'typescript', 'html', 'css'],
    enabled: cfg.enabled ?? false,
    priority: 100,
    async run(req: RunRequest, ctx: RunContext): Promise<RunResult> {
      const body = buildPistonBody(req, cfg);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/api/v2/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      if (!res.ok) {
        return newResult({
          requestId: ctx.requestId,
          language: req.language,
          target: 'server',
          engine: 'piston.v2',
          status: 'unavailable',
          diagnostics: [diagnostic('error', `执行服务返回 HTTP ${res.status}`, 'http')],
        });
      }
      const data = (await res.json()) as PistonResponse;
      return mapPistonResponse(data, req, ctx.requestId);
    },
  };
}
