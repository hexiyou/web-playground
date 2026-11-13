/**
 * A′ 本机进程执行器（local.process.v1）—— Piston v2 兼容子集的客户端。
 *
 * 决策分叉见分析手册第十三章：官方推荐 Docker + privileged + 纯 cgroup v2 的 isolate，
 * 本项目初期刻意采用非 Docker、Windows 原生、仅绑 127.0.0.1 的本地进程节点。
 * 因为团队内是可信代码，威胁模型不同，但能力表必须如实登记：
 *   isolation = process-only，trust = advisory（不可用于判分）。
 *
 * HTTP 接口与 Piston v2 同形，线协议纯函数直接复用 protocol.ts；
 * 将来切到官方 Docker 部署只需把注入的 Runner 换成 piston.v2。
 *
 * ★ v0.6：节点侧 /api/v2/runtimes 每次真探测「这一刻本机能不能跑」，探测不到的语言
 *   根本不会出现在版本表里；本 Runner 遇到这类语言直接 unavailable 并给出安装/配置指引，
 *   不静默降级到 browser。运行时可执行文件可在节点侧 runtimes.local.json 按语言指定
 *   绝对路径（便携式环境），前端不暴露也不需要感知这个选项。
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
} from './protocol';

/** A′ 用本机可执行/运行时名，不抄 Piston 的 file / sqlite3 这类专有名。 */
export const LOCAL_LANGUAGES: ServerLanguageMap = Object.freeze({
  go: 'go',
  php: 'php',
  perl: 'perl',
  r: 'r',
});

export interface LocalConfig {
  /** 默认 http://127.0.0.1:2000，节点只绑回环地址 */
  baseUrl: string;
  /** 与节点 -token 一致；节点开启鉴权时必填 */
  token?: string;
  /** 探测 runtimes 的超时，默认 3s */
  probeTimeoutMs?: number;
  enabled?: boolean;
}

interface RuntimeEntry {
  language: string;
  version: string;
  aliases?: string[];
  /** A′ 扩展：config = 配置里指定 path；path = 从 PATH 找到。 */
  source?: string;
}

/** 版本真值来自 GET /api/v2/runtimes，不硬编码；30 秒内复用，避免每次执行多一跳。 */
export class RuntimeCache {
  private versions: Partial<Record<LangId, string>> | null = null;
  private at = 0;

  constructor(private readonly ttlMs = 30_000) {}

  invalidate(): void {
    this.versions = null;
    this.at = 0;
  }

  async get(baseUrl: string, token: string | undefined, signal: AbortSignal): Promise<Partial<Record<LangId, string>>> {
    if (this.versions && Date.now() - this.at < this.ttlMs) return this.versions;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}/api/v2/runtimes`, { headers, signal });
    if (!res.ok) throw new Error(`执行节点 /api/v2/runtimes 返回 HTTP ${res.status}`);
    const list = (await res.json()) as RuntimeEntry[];
    const map: Partial<Record<LangId, string>> = {};
    for (const entry of list) {
      const lang = Object.keys(LOCAL_LANGUAGES).find((k) => LOCAL_LANGUAGES[k as LangId] === entry.language);
      if (lang) map[lang as LangId] = entry.version;
    }
    this.versions = map;
    this.at = Date.now();
    return map;
  }
}

function unavailable(req: RunRequest, ctx: RunContext, reason: string): RunResult {
  return newResult({
    requestId: ctx.requestId,
    language: req.language,
    target: 'server',
    engine: 'local.process.v1',
    status: 'unavailable',
    diagnostics: [diagnostic('error', reason, 'link')],
  });
}

export function createLocalRunner(cfg: LocalConfig): Runner {
  const baseUrl = cfg.baseUrl.replace(/\/$/, '');
  const cache = new RuntimeCache();

  return {
    id: 'local.process.v1',
    target: 'server',
    languages: ['go', 'php', 'perl', 'r'],
    enabled: cfg.enabled ?? true,
    // ★ 如实登记：只有进程级限额，结果不可用于判分；不能因为 target=server 就冒充可信。
    isolation: 'process-only',
    trust: 'advisory',
    priority: 100,
    async run(req: RunRequest, ctx: RunContext): Promise<RunResult> {
      let versions: Partial<Record<LangId, string>>;
      try {
        versions = await cache.get(baseUrl, cfg.token, ctx.signal);
      } catch (err) {
        return unavailable(
          req,
          ctx,
          `本地执行节点未就绪（${err instanceof Error ? err.message : String(err)}）；请先运行 npm run server`,
        );
      }
      if (!versions[req.language]) {
        cache.invalidate();
        return unavailable(
          req,
          ctx,
          `执行节点未登记 ${req.language} 运行时：本机缺解释器或探测失败；` +
            '可安装到 PATH，或在 servers/local/runtimes.local.json 里给便携式运行时配 path（见节点 README）',
        );
      }

      let body: Record<string, unknown>;
      try {
        body = buildExecuteBody(req, {
          versions,
          languageMap: LOCAL_LANGUAGES,
          compileWallMs: 10_000,
          outputMaxBytes: req.limits.outputBytes,
        });
      } catch (err) {
        return unavailable(req, ctx, err instanceof Error ? err.message : String(err));
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

      try {
        const res = await fetch(`${baseUrl}/api/v2/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        if (!res.ok) {
          return unavailable(req, ctx, `执行节点返回 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
        }
        const data = (await res.json()) as ServerResponse;
        return emitServerResult(
          mapExecuteResponse(data, req, ctx.requestId, 'local.process.v1'),
          ctx,
        );
      } catch (err) {
        if (ctx.signal.aborted) {
          return unavailable(req, ctx, '执行被取消或链路超时');
        }
        return unavailable(
          req,
          ctx,
          `执行节点链路失败（${err instanceof Error ? err.message : String(err)}）；确认 npm run server 仍在运行`,
        );
      }
    },
  };
}
