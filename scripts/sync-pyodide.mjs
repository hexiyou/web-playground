/**
 * 把 npm 包 pyodide（= 官方 pyodide-core 分发）里的运行时文件同步到 public/pyodide/。
 *
 * 为什么需要这一步：
 *  loadPyodide() 的 indexURL 默认是「加载 pyodide.mjs 的那个目录去掉文件名」。
 *  在 Vite 里 pyodide.mjs 被打进 worker chunk，那个默认前缀指向 /assets/ 且文件名
 *  带 hash，而 Pyodide 要按固定文件名拼 pyodide.asm.mjs / pyodide.asm.wasm /
 *  python_stdlib.zip / pyodide-lock.json —— 必须给一整套保持原名的同源目录。
 *
 * 这些是运行时产物，不入库（.gitignore 排 public/pyodide/），由
 *  ① npm postinstall  ② Vite 插件 buildStart/configureServer 幂等生成。
 * 版本精确 pin 在 package.json，manifest.json 记录版本与字节数，
 * 判据可以直接押「版本一致 + 文件齐全 + URL 同源」，不押「加载没抛错」。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', 'pyodide');
const dest = join(root, 'public', 'pyodide');
const manifestPath = join(dest, 'manifest.json');

/** loadPyodide 会按这些固定文件名去 indexURL 下取，一个都不能少。 */
const FILES = [
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
  'pyodide.mjs',
];

export function ensurePyodideAssets({ force = false } = {}) {
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  const version = pkg.version;
  const sizes = Object.fromEntries(FILES.map((name) => [name, statSync(join(src, name)).size]));

  let unchanged = false;
  if (!force && existsSync(manifestPath)) {
    try {
      const old = JSON.parse(readFileSync(manifestPath, 'utf8'));
      unchanged =
        old.version === version &&
        FILES.every(
          (name) =>
            old.files?.[name] === sizes[name] &&
            existsSync(join(dest, name)) &&
            statSync(join(dest, name)).size === sizes[name],
        );
    } catch {
      unchanged = false;
    }
  }

  if (unchanged) return { version, action: 'unchanged', bytes: Object.values(sizes).reduce((a, b) => a + b, 0) };

  mkdirSync(dest, { recursive: true });
  for (const name of FILES) copyFileSync(join(src, name), join(dest, name));
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version,
        source: `npm:pyodide@${version} (pyodide-core)`,
        files: sizes,
        note: '运行时产物，由 scripts/sync-pyodide.mjs 幂等生成，不入库',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return {
    version,
    action: 'synced',
    bytes: Object.values(sizes).reduce((a, b) => a + b, 0),
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  try {
    const r = ensurePyodideAssets({ force: process.argv.includes('--force') });
    console.log(
      `[pyodide-assets] ${r.action} · v${r.version} · ${(r.bytes / 1048576).toFixed(2)} MB → public/pyodide/`,
    );
  } catch (err) {
    console.error('[pyodide-assets] 同步失败：', err.message || err);
    console.error('先执行 npm install（pyodide 必须精确安装）');
    process.exitCode = 1;
  }
}
