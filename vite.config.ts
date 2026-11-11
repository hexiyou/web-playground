import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
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

export default defineConfig({
  plugins: [analysisDoc()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
