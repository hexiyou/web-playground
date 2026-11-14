/**
 * 官方 Piston（Docker / Linux / isolate）后端实现。
 *
 * v0.5 起它只是 protocol.ts 的一个「配置 + 传输」实例：线协议与状态映射已抽到
 * protocol.ts，A′ 本机执行节点复用同一套纯函数。将来切到官方 Docker 部署，
 * 只需把 createRegistry 注入的 Runner 从 local.process.v1 换成 piston.v2。
 *
 * 启用前必须满足（见分析手册第十一、十三章）：
 *  - 执行节点与业务/数据库/云凭据隔离；Piston 自身要求 --privileged 容器 + 纯 cgroup v2。
 *  - 公共 API 自 2026-02-15 起需授权，商业/个人项目不发证 ⇒ 自建实例。
 *  - 能力表要由 GET /api/v2/runtimes 动态生成，不要手写版本常量。
 */
import type {
  LangId,
  RunContext,
  RunRequest,
  RunResult,
  Runner,
} from '../../core/contract';
import { newResult, diagnostic } from '../../core/result';
import {
  buildExecuteBody,
  mapExecuteResponse,
  emitServerResult,
  type ServerLanguageMap,
  type ServerResponse,
  type ServerStage,
} from './protocol';

/** Piston 专有语言名。换后端时不进 LANG_DEFS，只在这里 / local.ts 各自维护。 */
export const PISTON_LANGUAGES: ServerLanguageMap = Object.freeze({
  javascript: 'javascript',
  typescript: 'typescript',
  html: 'file',
  css: 'file',
  lua: 'lua',
  sql: 'sqlite3',
  python: 'python',
  go: 'go',
  php: 'php',
  perl: 'perl',
  r: 'r',
  ruby: 'ruby',
});

export interface PistonConfig {
  baseUrl: string;
  token?: string;
  /** language → 已安装版本。真值应来自 GET /api/v2/runtimes */
  versions: Partial<Record<LangId, string>>;
  timeoutMs: number;
  /** 编译预算与执行预算分开，默认给 10s，避免 C++/Rust 首次编译被误杀 */
  compileWallMs?: number;
  /** 覆盖默认的 Piston 语言名映射，一般不用动 */
  languageMap?: ServerLanguageMap;
  enabled?: boolean;
}

export type PistonStage = ServerStage;
export type PistonResponse = ServerResponse;

/** 保留同名导出：现有判据与调用点一行不改。 */
export function buildPistonBody(req: RunRequest, cfg: PistonConfig): Record<string, unknown> {
  return buildExecuteBody(req, {
    versions: cfg.versions,
    languageMap: cfg.languageMap ?? PISTON_LANGUAGES,
    compileWallMs: cfg.compileWallMs,
  });
}

export function mapPistonResponse(
  resp: PistonResponse,
  req: RunRequest,
  requestId: string,
): RunResult {
  return mapExecuteResponse(resp, req, requestId, 'piston.v2');
}

export function createPistonRunner(cfg: PistonConfig): Runner {
  return {
    id: 'piston.v2',
    target: 'server',
    languages: ['javascript', 'typescript', 'html', 'css', 'lua', 'sql', 'python', 'go', 'php', 'perl', 'r', 'ruby'],
    enabled: cfg.enabled ?? false,
    // isolate = Linux namespaces + chroot + uid + cgroup，结果可用于判分。
    isolation: 'kernel',
    trust: 'graded',
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
      return emitServerResult(mapPistonResponse(data, req, ctx.requestId), ctx);
    },
  };
}
