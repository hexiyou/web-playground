/**
 * CPython WASM Worker（Pyodide 314.0.7 / CPython 3.14.2）。
 *
 * 四条硬约束：
 *  1. 整套 core 分发自托管。loadPyodide 的 indexURL 默认是「pyodide.mjs 所在目录」，
 *     在 Vite 里那指向带 hash 的 /assets/，而它要按固定文件名拼 pyodide.asm.mjs /
 *     pyodide.asm.wasm / python_stdlib.zip / pyodide-lock.json —— 必须由
 *     scripts/sync-pyodide.mjs 生成 public/pyodide/ 并显式传同源 indexURL。
 *  2. 两阶段计时：Worker 先 boot 发 ready，主线程收到才起墙钟并投递代码。
 *     9.6 MB wasm 的下载 + 实例化不算进用户代码预算。
 *  3. 绝不调用 loadPackagesFromImports()/loadPackage()。core 分发没有 wheel、
 *     没有 micropip，实测调用后会去外网拉包并挂起 17~25 秒，甚至静默返回空数组。
 *     首版只跑标准库；import 第三方包直接由 Python 抛 ModuleNotFoundError，
 *     我们再翻译成一句人话，全程零外联。
 *  4. 引擎复用。每次运行重建 Pyodide 要重新下载/实例化 9.6 MB wasm，
 *     十几条端到端判据会把自检拖到超时。成功运行后保留 Worker，用时新建的
 *     globals 隔离变量；只有超时 / 取消 / 内部错误才 terminate 并清空缓存。
 *
 * 如实登记的边界：sys.modules 在复用期间共享；没有 SharedArrayBuffer 中断，
 * 同步死循环只能靠 worker.terminate() 真杀；没有 allocator 上限，
 * usage.memoryBytes 一律不填（不拿 0 冒充）。
 */
import { loadPyodide } from 'pyodide';
import type { PyProxy } from 'pyodide/ffi';
import {
  PYTHON_PACKAGE_CAPABILITY,
  describePythonError,
  pythonMountPath,
  stdinBytes,
} from './python-shared';
import type {
  PythonDoneStatus,
  PythonRunMessage,
  PythonWorkerMessage,
} from './python-shared';

interface WorkerScope {
  postMessage(message: unknown): void;
  location: { href: string };
}

const scope = self as unknown as WorkerScope;
type Pyodide = Awaited<ReturnType<typeof loadPyodide>>;

/** BASE_URL 由 Vite 替换；绝对化后 dev 与 dist 都是同源 /pyodide/。 */
const indexURL = new URL(`${import.meta.env.BASE_URL}pyodide/`, scope.location.href).href;

let py: Pyodide | null = null;
let runs = 0;

function send(message: PythonWorkerMessage): void {
  scope.postMessage(message);
}

async function boot(): Promise<void> {
  const t0 = Date.now();
  try {
    py = await loadPyodide({
      indexURL,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const pythonVersion = String(py.runPython('import sys; sys.version.split()[0]'));
    // 附加文件统一挂到 /pg/，让第二文件可以 import。sys.path 是引擎级的，boot 时加一次即可。
    py.runPython(`import sys
if '/pg' not in sys.path: sys.path.insert(0, '/pg')`);
    py.FS.mkdir('/pg');
    send({
      __pg: true,
      kind: 'ready',
      pyodideVersion: py.version,
      pythonVersion,
      indexURL,
      wasmSource: `${indexURL}pyodide.asm.wasm`,
      stdLibURL: `${indexURL}python_stdlib.zip`,
      lockFileURL: `${indexURL}pyodide-lock.json`,
      packageCapability: PYTHON_PACKAGE_CAPABILITY,
      bootMs: String(Date.now() - t0),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({
      __pg: true,
      kind: 'error',
      message: `Pyodide WASM 初始化失败（indexURL=${indexURL}）：${message}`,
    });
    send({ __pg: true, kind: 'done', status: 'unavailable' });
  }
}

async function execute(msg: PythonRunMessage): Promise<void> {
  if (!py) {
    send({ __pg: true, kind: 'error', message: 'CPython 引擎未就绪' });
    send({ __pg: true, kind: 'done', status: 'unavailable' });
    return;
  }

  runs += 1;
  const engineReused = String(runs > 1 ? 1 : 0);
  const encoder = new TextEncoder();
  let bytes = 0;
  let outputLimited = false;
  let doneStatus: PythonDoneStatus = 'ok';
  let filesMounted = 0;
  let returnKind = 'none';

  /** worker 内部按 UTF-8 字节计数，与外层 collector 同一把尺子。 */
  const emit = (stream: 'stdout' | 'stderr' | 'info', text: string): void => {
    const size = encoder.encode(text).length;
    if (bytes + size > msg.outputBytes) {
      outputLimited = true;
      return;
    }
    bytes += size;
    send({ __pg: true, kind: 'out', stream, text });
  };

  // batched 回调按行给且不带换行，补回 \n 才不会把两行粘成一行。
  py.setStdout({ batched: (line: string) => emit('stdout', `${line}\n`) });
  py.setStderr({ batched: (line: string) => emit('stderr', `${line}\n`) });

  // read 型 stdin：每次填一段 UTF-8 字节，返回写入数，0 表示 EOF。
  // 比 stdin() 逐行回调可靠，多次 input() 都能读到。
  const data = stdinBytes(msg.stdin);
  let offset = 0;
  py.setStdin({
    read: (buffer: Uint8Array) => {
      if (offset >= data.length) return 0;
      const n = Math.min(buffer.length, data.length - offset);
      buffer.set(data.subarray(offset, offset + n));
      offset += n;
      return n;
    },
  });

  try {
    // 每次运行清空 /pg/，避免复用引擎时上一轮的附加文件残留。
    for (const name of py.FS.readdir('/pg')) {
      if (name === '.' || name === '..') continue;
      try {
        py.FS.unlink(`/pg/${name}`);
      } catch {
        /* 目录或已删除，交给后面的写入报错 */
      }
    }
    for (const file of msg.files.slice(1)) {
      const path = pythonMountPath(file.name);
      if (!path) continue;
      py.FS.writeFile(path, encoder.encode(file.content));
      filesMounted += 1;
    }
    // 主脚本也落盘，这样 Python 异常的 traceback 能显示源码行。
    py.FS.writeFile('/pg/main.py', encoder.encode(msg.code));

    const globals = py.toPy({ __name__: '__main__' }) as PyProxy;
    try {
      const ret: unknown = await py.runPythonAsync(msg.code, { globals, filename: '/pg/main.py' });
      if (ret !== undefined && ret !== null) {
        const proxy = ret as { destroy?: unknown };
        if (typeof ret === 'object' && typeof proxy.destroy === 'function') {
          // list/dict 等返回 PyProxy；不能直接 postMessage，也不该谎报成字符串。
          emit('info', '-- 返回值：<Python 对象，未展示>\n');
          (proxy.destroy as () => void)();
          returnKind = 'pyproxy';
        } else if (['number', 'string', 'boolean', 'bigint'].includes(typeof ret)) {
          emit('info', `-- 返回值：${String(ret)}\n`);
          returnKind = typeof ret;
        }
      }
    } finally {
      globals.destroy();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 完整 traceback 进 stderr（可观察），诊断区给一句人话（不联网承诺）。
    emit('stderr', `${message}\n`);
    send({ __pg: true, kind: 'error', message: describePythonError(message) });
    doneStatus = 'error';
  }

  if (doneStatus === 'ok' && outputLimited) doneStatus = 'output-limit';
  send({
    __pg: true,
    kind: 'meta',
    filesMounted: String(filesMounted),
    outputLimited: outputLimited ? '1' : '0',
    engineReused,
    returnKind,
  });
  send({ __pg: true, kind: 'done', status: doneStatus });
}

self.addEventListener('message', (ev: MessageEvent<unknown>) => {
  const data = ev.data as Partial<PythonRunMessage> | undefined;
  if (data?.__pg === true && data.kind === 'run') {
    void execute(data as PythonRunMessage);
  }
});

void boot();
