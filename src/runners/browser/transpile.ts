import type { Diagnostic } from '../../core/contract';

export interface TranspileOutcome {
  code: string;
  diagnostics: Diagnostic[];
}

type TsModule = typeof import('typescript');

let cached: TsModule | null = null;

/** 动态 import，TS 编译器不进首屏 chunk。 */
async function loadTypeScript(): Promise<TsModule> {
  if (!cached) cached = await import('typescript');
  return cached;
}

/**
 * 语法转译，不做类型检查。
 * 首版明确不支持模块导入/导出：模块解析要靠完整 bundler，那是后面单独一轮的事。
 */
export async function transpileTypeScript(
  source: string,
  fileName = 'main.ts',
): Promise<TranspileOutcome> {
  if (/^\s*(import|export)\s/m.test(source)) {
    return {
      code: '',
      diagnostics: [
        {
          level: 'error',
          message: '首版不支持 import / export，请把片段写成单文件自包含代码',
          code: 'module-unsupported',
        },
      ],
    };
  }

  const ts = await loadTypeScript();
  const out = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      strict: false,
      isolatedModules: true,
    },
  });

  const diagnostics: Diagnostic[] = (out.diagnostics ?? []).map((d) => ({
    level: d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    code: String(d.code),
  }));

  return { code: out.outputText, diagnostics };
}
