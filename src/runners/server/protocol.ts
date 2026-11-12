/**
 * Piston v2 线协议 —— A′（本机进程执行节点）与官方 Piston 共用的唯一真值。
 *
 * v0.5 抽掉的接缝：本地执行节点按 Piston v2 兼容子集实现 HTTP 接口，
 * 于是这两个纯函数原样复用；将来切到官方 Docker 部署只需换 baseUrl 与 Runner 实例，
 * 契约层、UI、路由、能力表都不动。
 *
 * 纪律：所有限额显式传，绝不吃对方默认值（Piston 的 run_memory_limit 默认是 -1）。
 */
import type {
  Diagnostic,
  LangId,
  RunContext,
  RunRequest,
  RunResult,
} from '../../core/contract';
import { mapServerStatus } from '../../core/limits';
import { newResult, diagnostic } from '../../core/result';

/** 后端专有的语言名映射。Piston 用 file/sqlite3，A′ 用本机可执行名 go。 */
export type ServerLanguageMap = Partial<Record<LangId, string>>;

export interface ServerProtocolConfig {
  /** language → 已安装版本。真值应来自 GET /api/v2/runtimes */
  versions: Partial<Record<LangId, string>>;
  languageMap: ServerLanguageMap;
  /** 编译预算与执行预算分开，默认给 10s，避免编译型语言首次编译被误杀 */
  compileWallMs?: number;
  /** 仅 A′ 支持：节点自己按这个字节数截断 stdio。官方 Piston 由环境变量配置，不传。 */
  outputMaxBytes?: number;
}

export interface ServerStage {
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

export interface ServerResponse {
  language?: string;
  version?: string;
  run: ServerStage;
  compile?: ServerStage;
  /** A′ 节点额外回报的可观测事实；官方 Piston 没有，映射时会忽略。 */
  probes?: Record<string, string>;
}

/**
 * ★ 把纯函数产出的 outputs 交给 ctx.emit，而不是让 Runner 直接返回 outputs。
 *   execute.ts 是唯一执行入口，会用 collector.snapshot() 覆盖 runner 返回的 outputs，
 *   输出字节限额也在那里统一收口。服务端骨架从 v0.1 写到 v0.4 一直没真机接线，
 *   纯函数单测全绿却没人发现「返回了 outputs 也会被丢掉」——典型的连线层盲区。
 *   纯函数仍保留 outputs 字段供单测直接押，接线时由本函数转接。
 */
export function emitServerResult(result: RunResult, ctx: RunContext): RunResult {
  for (const chunk of result.outputs) {
    ctx.emit({ stream: chunk.stream, text: chunk.text });
  }
  return { ...result, outputs: [] };
}

/** RunRequest → Piston v2 execute body。 */
export function buildExecuteBody(
  req: RunRequest,
  cfg: ServerProtocolConfig,
): Record<string, unknown> {
  const language = cfg.languageMap[req.language];
  const version = cfg.versions[req.language];
  if (!language) {
    throw new Error(`后端未登记 ${req.language} 的语言名；换后端要先补 languageMap`);
  }
  if (!version) {
    throw new Error(`未登记 ${req.language} 的服务端版本；请先读 GET /api/v2/runtimes`);
  }
  const body: Record<string, unknown> = {
    language,
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
  if (cfg.outputMaxBytes !== undefined) body.output_max_size = cfg.outputMaxBytes;
  return body;
}

/** Piston v2 阶段状态 → 统一 RunResult。六种状态都有归宿。engine 由具体实现传入。 */
export function mapExecuteResponse(
  resp: ServerResponse,
  req: RunRequest,
  requestId: string,
  engine: string,
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
      engine,
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
    ...(resp.probes ? { probes: resp.probes } : {}),
  };
}
