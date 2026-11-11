import type { BrowserSandbox, Capability, ExecTarget, LangId } from './contract';
import type { RunnerRegistry } from './registry';

export interface LangDef {
  lang: LangId;
  label: string;
  extensions: string[];
  browserSandbox: BrowserSandbox;
  switchable: BrowserSandbox[];
  /** 只有浏览器才有的语义，用于解释为什么 A 层不能砍 */
  nativeApis: string[];
  /** 后期接 Piston 时的 language 名，先登记，不接线 */
  serverLanguage: string;
}

export const LANG_DEFS: readonly LangDef[] = Object.freeze([
  {
    lang: 'javascript',
    label: 'JavaScript',
    extensions: ['js'],
    browserSandbox: 'worker',
    switchable: ['worker', 'iframe'],
    nativeApis: ['console', 'DOM（iframe 模式）', 'fetch（iframe 模式）'],
    serverLanguage: 'javascript',
  },
  {
    lang: 'typescript',
    label: 'TypeScript',
    extensions: ['ts'],
    browserSandbox: 'worker',
    switchable: ['worker', 'iframe'],
    nativeApis: ['console', 'DOM（iframe 模式）'],
    serverLanguage: 'typescript',
  },
  {
    lang: 'html',
    label: 'HTML',
    extensions: ['html'],
    browserSandbox: 'iframe',
    switchable: ['iframe'],
    nativeApis: ['DOM', 'CSS', 'inline script', '事件'],
    serverLanguage: 'file',
  },
  {
    lang: 'css',
    label: 'CSS',
    extensions: ['css'],
    browserSandbox: 'iframe',
    switchable: ['iframe'],
    nativeApis: ['布局', '级联', 'computed style'],
    serverLanguage: 'file',
  },
  {
    lang: 'lua',
    label: 'Lua',
    extensions: ['lua'],
    browserSandbox: 'worker',
    switchable: ['worker'],
    nativeApis: ['Lua 5.4 标准库（WASM）', 'io.read 走注入的 stdin', 'dofile 走内存 FS'],
    serverLanguage: 'lua',
  },
  {
    lang: 'sql',
    label: 'SQL',
    extensions: ['sql'],
    browserSandbox: 'worker',
    switchable: ['worker'],
    nativeApis: ['SQLite 3.54（WASM）', '同一次运行内多语句共享 DB', '附加 .sql 文件作初始化脚本'],
    serverLanguage: 'sqlite3',
  },
]);

export function langDef(lang: LangId): LangDef {
  const def = LANG_DEFS.find((d) => d.lang === lang);
  if (!def) throw new Error(`未登记的语言：${lang}`);
  return def;
}

/**
 * 能力表由注册表推导，不手写「我以为能用」。
 * targets 为空 = 未接线，UI 必须置灰。这是防止「单测全绿但功能没接线」的结构性手段。
 */
export function deriveCapabilities(reg: RunnerRegistry): Capability[] {
  return LANG_DEFS.map((def) => {
    const wired = reg.active(def.lang);
    const targets = [...new Set<ExecTarget>(wired.map((r) => r.target))];
    const prefer: ExecTarget | null = targets.includes('browser')
      ? 'browser'
      : targets.includes('server')
        ? 'server'
        : null;
    const available = targets.length > 0;

    return {
      lang: def.lang,
      label: def.label,
      extensions: [...def.extensions],
      targets,
      prefer,
      available,
      offline: targets.includes('browser'),
      trusted: targets.includes('server'),
      browserSandbox: def.browserSandbox,
      switchable: [...def.switchable],
      nativeApis: [...def.nativeApis],
      runnerIds: wired.map((r) => r.id),
      reason: available
        ? undefined
        : `未接线：${def.label} 没有已启用的 runner，按钮不可用`,
    };
  });
}

export function capabilityFor(caps: readonly Capability[], lang: LangId): Capability {
  const cap = caps.find((c) => c.lang === lang);
  if (!cap) throw new Error(`能力表缺少语言：${lang}`);
  return cap;
}

/**
 * 门控自检：能力表声称可用的语言，注册表里必须真有能跑的 runner，且 run 真的是函数。
 * 返回问题列表；空数组 = 通过。UI 启动时和自检模式都要跑一次。
 */
export function validateWiring(reg: RunnerRegistry, caps: readonly Capability[]): string[] {
  const problems: string[] = [];
  for (const cap of caps) {
    const wired = reg.active(cap.lang);
    if (cap.available && wired.length === 0) {
      problems.push(`${cap.lang}：能力表声称可用，注册表却没有已启用的 runner`);
    }
    if (!cap.available && wired.length > 0) {
      problems.push(`${cap.lang}：能力表声称未接线，注册表却有 ${wired.length} 个可用 runner`);
    }
    const declared = new Set(cap.targets);
    for (const r of wired) {
      if (!declared.has(r.target)) {
        problems.push(`${cap.lang}：runner ${r.id} 的 target=${r.target} 未出现在能力表`);
      }
    }
    if (!cap.available && !cap.reason) {
      problems.push(`${cap.lang}：置灰但没有可读理由`);
    }
  }
  return problems;
}
