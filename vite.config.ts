import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** 分析手册只保留一份真值（项目根），dev 与 build 都从它读，不产生会漂移的副本。 */
function analysisDoc(): Plugin {
  const file = root('./playground-architecture-analysis.html');
  let html = '';
  return {
    name: 'playground-analysis-doc',
    buildStart() {
      html = readFileSync(file, 'utf8');
    },
    configureServer(server) {
      server.middlewares.use('/playground-architecture-analysis.html', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html || readFileSync(file, 'utf8'));
      });
    },
    generateBundle() {
      if (html) {
        this.emitFile({
          type: 'asset',
          fileName: 'playground-architecture-analysis.html',
          source: html,
        });
      }
    },
  };
}

/**
 * Pyodide 的 core 分发是一整套固定文件名的目录，不能像单文件 wasm 那样用 ?url。
 * 这里只负责「幂等地调用同步脚本」，复制逻辑单一真值在 scripts/sync-pyodide.mjs，
 * 避免 dev / build / postinstall 三处各写一份而漂移。
 */
function pyodideAssets(): Plugin {
  const script = root('./scripts/sync-pyodide.mjs');
  const ensure = () => {
    try {
      execFileSync(process.execPath, [script], { cwd: root('./'), stdio: 'pipe' });
    } catch (err) {
      const detail = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : String(err);
      throw new Error(`Pyodide 运行时资产同步失败（先跑 npm install）：${detail.slice(0, 300)}`);
    }
  };
  return {
    name: 'playground-pyodide-assets',
    buildStart() {
      ensure();
    },
    configureServer() {
      ensure();
    },
  };
}

export default defineConfig({
  plugins: [analysisDoc(), pyodideAssets()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
  },
  // Lua runner 是 module Worker，里面要 import wasmoon(UMD) 与 glue.wasm?url；
  // ES 格式才允许 Worker 内部用 ESM 导入。
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
