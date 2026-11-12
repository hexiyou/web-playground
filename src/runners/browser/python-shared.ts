/**
 * Python WASM runner 的共享真值：消息协议、纯函数判定、能力缺口描述。
 *
 * 与 lua-shared.ts / sql-shared.ts 同构：只放「不依赖 DOM / Worker / Pyodide」的
 * 纯逻辑，主 runner 与 Worker 各自打进自己的 chunk 后仍能在 Node 单测里直接验。
 */
import type { RunFile } from '../../core/contract';

/** package.json 里精确 pin 的版本；manifest.json 与 probes 都按这个核对。 */
export const PYODIDE_VERSION = '314.0.7';

/**
 * 能力缺口如实登记：npm 包 pyodide 就是官方 pyodide-core，只有 CPython 标准库，
 * 没有任何 wheel、也没有 micropip。绝不调用 loadPackagesFromImports()/loadPackage()：
 * 实测这两者在缺 wheel 时会去外网拉包，loadPackagesFromImports('import numpy')
 * 挂起 25 秒以上，loadPackage('numpy') 耗 17.8 秒后还「成功」返回空数组。
 * ⇒ 首版只跑标准库，第三方包给出可读错误，不发起任何外部请求。
 */
export const PYTHON_PACKAGE_CAPABILITY =
  'stdlib-only: core 分发无 wheel / 无 micropip；禁用自动装包，第三方包给可读错误';

export interface PythonRunMessage {
  __pg: true;
  kind: 'run';
  requestId: string;
  code: string;
  files: RunFile[];
  stdin: string;
  outputBytes: number;
}

export type PythonDoneStatus =
  | 'ok'
  | 'error'
  | 'output-limit'
  | 'internal'
  | 'unavailable';

export type PythonWorkerMessage =
  | {
      __pg: true;
      kind: 'ready';
      pyodideVersion: string;
      pythonVersion: string;
      indexURL: string;
      wasmSource: string;
      stdLibURL: string;
      lockFileURL: string;
      packageCapability: string;
      bootMs: string;
    }
  | { __pg: true; kind: 'out'; stream: 'stdout' | 'stderr' | 'info'; text: string }
  | { __pg: true; kind: 'error'; message: string }
  | {
      __pg: true;
      kind: 'meta';
      filesMounted: string;
      outputLimited: string;
      engineReused: string;
      returnKind: string;
    }
  | { __pg: true; kind: 'done'; status: PythonDoneStatus };

export function isPythonWorkerMessage(v: unknown): v is PythonWorkerMessage {
  return typeof v === 'object' && v !== null && (v as { __pg?: unknown }).__pg === true;
}

/**
 * 多文件挂载路径。按净结果判逃逸：只接受一个干净文件名，统一挂到 /pg/ 下，
 * 绝不拼进用户给的路径（否则第二个文件能覆盖 Pyodide 自己的 /lib 内容）。
 */
export function pythonMountPath(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/[\/\\\u0000-\u001f]/.test(trimmed)) return null;
  if (!/^[\p{L}\p{N}._-]+$/u.test(trimmed)) return null;
  if (trimmed.includes('..')) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  return `/pg/${trimmed}`;
}

/**
 * Pyodide 对「lockfile 里有但没装」的包会给出带 install 提示的 ModuleNotFoundError。
 * 提取包名，让诊断直接说清楚缺的是什么，而不是丢一整段 traceback 给用户。
 */
export function missingPythonPackage(message: string): string | null {
  const m = /No module named ['"]?([A-Za-z_][A-Za-z0-9_.-]*)['"]?/.exec(message);
  return m ? m[1] : null;
}

/** 把 Python 异常压成「一句人话 + 不联网承诺」，完整 traceback 仍走 stderr。 */
export function describePythonError(message: string): string {
  const pkg = missingPythonPackage(message);
  if (!pkg) return message;
  return (
    `第三方包 ${pkg} 未随自托管 Pyodide core 分发提供（首版仅 Python 标准库）。` +
    `不会向 CDN / PyPI 发起请求；如需支持，把对应 wasm wheel 放进 public/pyodide/ 并登记后再启用装包。`
  );
}

/** 复用 Lua 那轮已验证过的同源判定，不重复实现同一条规则。 */
export { isSelfHostedWasm } from './lua-shared';

/** 附加文件按顺序挂成可 import 的模块；主脚本永远是 files[0]。 */
export function pythonInitFiles(files: readonly RunFile[]): RunFile[] {
  return files.slice(1).filter((f) => typeof f.content === 'string' && pythonMountPath(f.name) !== null);
}

/** stdin 切成字节流供 setStdin({read}) 逐行喂给 input()。 */
export function stdinBytes(stdin: string): Uint8Array {
  return new TextEncoder().encode(stdin);
}
