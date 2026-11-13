/**
 * Runner 契约 —— 全项目唯一真值。
 *
 * 三条约束（都是踩过的坑，别改回去）：
 *  1. 执行位置 browser | server 是一等公民。UI 只认 ExecTarget，不认具体后端；
 *     后期接 Piston / Judge0 / microVM 时，UI 一行不用改。
 *  2. 「没有」不等于「0」。浏览器没有进程退出码，exitCode 用 null，不假装 0。
 *  3. 能力表由 runner 注册表推导（见 capabilities.ts），不允许手写「我以为能用」。
 *     单测对「没接线」天生免疫，只有接线层能作证。
 */

export type ExecTarget = 'browser' | 'server';

/** 浏览器内的执行载体：Worker 可 terminate；iframe 有 DOM 但只能靠重建中止。 */
export type BrowserSandbox = 'worker' | 'iframe';

export type LangId = 'javascript' | 'typescript' | 'html' | 'css' | 'lua' | 'sql' | 'python' | 'go' | 'php';

/**
 * 隔离档位由 runner 自己声明，能力表只做汇总，绝不按 target 猜。
 * v0.5 的教训：A′ 是 target=server 但只有 process-only 隔离，若按「server ⇒ 可信」
 * 硬推导，能力表就会把不可判分的结果标成可信。
 */
export type IsolationLevel = 'browser' | 'wasm' | 'process-only' | 'kernel';

/** graded = 结果可用于判分；advisory = 仅供人看，不可当裁判。 */
export type TrustLevel = 'graded' | 'advisory';

export type RunStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'output-limit'
  | 'memory-limit'
  | 'unsupported'
  | 'unavailable'
  | 'internal';

export interface Diagnostic {
  level: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
}

/** cpuMs / memoryBytes 在浏览器侧只能近似，但字段必须现在就留好，否则 server 迁移要改契约。 */
export interface RunLimits {
  wallMs: number;
  cpuMs: number;
  memoryBytes: number;
  outputBytes: number;
}

export interface RunFile {
  name: string;
  content: string;
}

export interface RunRequest {
  language: LangId;
  /** 第一个文件为主文件；CSS 语言可带第二个 HTML 文件覆盖示例骨架 */
  files: RunFile[];
  stdin?: string;
  limits: RunLimits;
  /** 显式指定执行位置；undefined = 由能力表 prefer 决定 */
  target?: ExecTarget;
  /** JS/TS 可切换执行载体；其它语言忽略 */
  sandbox?: BrowserSandbox;
}

export interface OutputChunk {
  stream: 'stdout' | 'stderr' | 'info';
  text: string;
  seq: number;
}

export interface RunResult {
  requestId: string;
  language: LangId;
  status: RunStatus;
  /** 实际执行位置，不是请求里写的位置 */
  target: ExecTarget | null;
  /** 例如 browser.worker / browser.iframe / piston.v2 */
  engine: string | null;
  outputs: OutputChunk[];
  /** null = 该后端没有退出码语义；不要用 0 冒充成功 */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
  /**
   * 运行后可观测的结构化事实，专供验收判据读取（例如预览页的可见文本、computed style）。
   * 判据要押「能读回字节」，不要在输出文本里做字符串匹配。
   */
  probes?: Record<string, string>;
  /** HTML/CSS 的渲染产物，与 stdout 分开，避免把整个页面塞进日志 */
  preview?: { kind: 'html'; srcdoc: string };
  /** 服务端返回后才有的资源账 */
  usage?: { cpuMs?: number; wallMs?: number; memoryBytes?: number };
}

export interface RunContext {
  requestId: string;
  signal: AbortSignal;
  now(): number;
  /** 流式输出；seq 由 collector 统一编号 */
  emit(chunk: Omit<OutputChunk, 'seq'>): void;
}

export interface Runner {
  readonly id: string;
  readonly target: ExecTarget;
  /** 仅 browser runner：声明载体，供 req.sandbox 精确选择 */
  readonly sandbox?: BrowserSandbox;
  readonly languages: readonly LangId[];
  readonly enabled: boolean;
  /**
   * 隔离与信任档位。浏览器 runner 省略即为 browser / advisory；
   * 服务端 runner 必须显式声明，A′ 是 process-only / advisory，Piston 是 kernel / graded。
   */
  readonly isolation?: IsolationLevel;
  readonly trust?: TrustLevel;
  /** 同一 target 下多个 runner 时，数值小的先选 */
  readonly priority: number;
  run(req: RunRequest, ctx: RunContext): Promise<RunResult>;
  cancel?(requestId: string): void;
}

/** 能力表条目。targets 为空 = 未接线，UI 必须置灰并展示 reason。 */
export interface Capability {
  lang: LangId;
  label: string;
  extensions: string[];
  targets: ExecTarget[];
  prefer: ExecTarget | null;
  available: boolean;
  offline: boolean;
  /** 存在可用于判分的可信路径；由 runner 声明的 trust 推导，不是由 target 推导 */
  trusted: boolean;
  /** 当前已接线 runner 的隔离档位汇总，供 UI 如实展示 */
  isolation: IsolationLevel[];
  /** 最高信任档；null = 没有已接线 runner */
  trust: TrustLevel | null;
  browserSandbox: BrowserSandbox;
  switchable: BrowserSandbox[];
  nativeApis: string[];
  runnerIds: string[];
  reason?: string;
}
