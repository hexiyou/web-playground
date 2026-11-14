import type { BrowserSandbox, Capability, ExecTarget, IsolationLevel, LangId, TrustLevel } from './contract';
import type { RunnerRegistry } from './registry';

export interface LangDef {
  lang: LangId;
  label: string;
  extensions: string[];
  browserSandbox: BrowserSandbox;
  switchable: BrowserSandbox[];
  /** 只有浏览器才有的语义，用于解释为什么 A 层不能砍 */
  nativeApis: string[];
}

/**
 * v0.5 抽掉的接缝：语言元数据里不再写「服务端 language 名」。
 * `file` / `sqlite3` 这类是 Piston 专有命名，A′ 用本机可执行名（go / Rscript…），
 * 写死在 LANG_DEFS 会让换后端时连语言登记层都要返工。现在各 runner 自带映射表。
 */
export const LANG_DEFS: readonly LangDef[] = Object.freeze([
  {
    lang: 'javascript',
    label: 'JavaScript',
    extensions: ['js'],
    browserSandbox: 'worker',
    switchable: ['worker', 'iframe'],
    nativeApis: ['console', 'DOM（iframe 模式）', 'fetch（iframe 模式）'],
  },
  {
    lang: 'typescript',
    label: 'TypeScript',
    extensions: ['ts'],
    browserSandbox: 'worker',
    switchable: ['worker', 'iframe'],
    nativeApis: ['console', 'DOM（iframe 模式）'],
  },
  {
    lang: 'html',
    label: 'HTML',
    extensions: ['html'],
    browserSandbox: 'iframe',
    switchable: ['iframe'],
    nativeApis: ['DOM', 'CSS', 'inline script', '事件'],
  },
  {
    lang: 'css',
    label: 'CSS',
    extensions: ['css'],
    browserSandbox: 'iframe',
    switchable: ['iframe'],
    nativeApis: ['布局', '级联', 'computed style'],
  },
  {
    lang: 'lua',
    label: 'Lua',
    extensions: ['lua'],
    browserSandbox: 'worker',
    switchable: ['worker'],
    nativeApis: ['Lua 5.4 标准库（WASM）', 'io.read 走注入的 stdin', 'dofile 走内存 FS'],
  },
  {
    lang: 'sql',
    label: 'SQL',
    extensions: ['sql'],
    browserSandbox: 'worker',
    switchable: ['worker'],
    nativeApis: ['SQLite 3.54（WASM）', '同一次运行内多语句共享 DB', '附加 .sql 文件作初始化脚本'],
  },
  {
    lang: 'python',
    label: 'Python',
    extensions: ['py'],
    browserSandbox: 'worker',
    switchable: ['worker'],
    nativeApis: ['CPython 3.14（WASM）', 'Python 标准库（python_stdlib.zip）', '附加 .py 文件挂内存 FS 可 import'],
  },
  {
    lang: 'go',
    label: 'Go',
    extensions: ['go'],
    // 纯服务端语言：没有 browser runner，switchable 为空，UI 会把载体下拉置灰。
    browserSandbox: 'worker',
    switchable: [],
    nativeApis: ['（仅服务端执行）', '本机 Go 工具链 · go build + 运行两阶段', '仅标准库，GOPROXY=off'],
  },
  {
    lang: 'php',
    label: 'PHP',
    extensions: ['php'],
    browserSandbox: 'worker',
    switchable: [],
    nativeApis: [
      '（仅服务端执行）',
      '本机 PHP CLI · 单阶段解释执行，无 compile',
      'php.ini 用宿主机默认；allow_url_fopen=0 关闭 URL 包装器',
    ],
  },
  {
    lang: 'perl',
    label: 'Perl',
    extensions: ['pl'],
    browserSandbox: 'worker',
    switchable: [],
    nativeApis: [
      '（仅服务端执行）',
      '本机 Perl 5 · 单阶段解释执行，宿主风味由 $^O 动态探测',
      '可挂 Cygwin / Strawberry / ActivePerl；节点按语言配绝对路径',
      '中文须 use utf8 + binmode(STDOUT, ":encoding(UTF-8)")',
    ],
  },
  {
    lang: 'r',
    label: 'R',
    extensions: ['R', 'r'],
    browserSandbox: 'worker',
    switchable: [],
    nativeApis: [
      '（仅服务端执行）',
      'Cygwin R 4.2 · 入口是 #!/bin/sh 脚本，由同目录 sh.exe 包装启动',
      '单阶段 --vanilla --slave --file=；风味由 --version 的 Platform 行动态探测',
      '宿主缺 cyglapack-0.dll 时 stats 不可用，stderr 如实告警不掩盖',
    ],
  },
  {
    lang: 'ruby',
    label: 'Ruby',
    extensions: ['rb'],
    browserSandbox: 'worker',
    switchable: [],
    nativeApis: [
      '（仅服务端执行）',
      'RubyInstaller 4.0 · 原生 PE 入口，PATH 直接发现，不需要 sh.exe 包装',
      '单阶段 ruby -I . main.rb；风味由 --version 的 [platform] 动态探测',
      'Windows 原生 puts 输出 CRLF，节点不归一化；标准库可用，第三方 gem 随机器',
    ],
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
 *
 * ★ trusted 只认 runner 声明的 trust，不认 target：A′ 也是 server，但只有进程级隔离，
 *   结果不可用于判分。按位置猜信任档会让能力表撒谎。
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
    const isolation: IsolationLevel[] = [...new Set(wired.map((r) => r.isolation ?? 'browser'))];
    const trust: TrustLevel | null = wired.length === 0
      ? null
      : wired.some((r) => r.trust === 'graded')
        ? 'graded'
        : 'advisory';

    return {
      lang: def.lang,
      label: def.label,
      extensions: [...def.extensions],
      targets,
      prefer,
      available,
      offline: targets.includes('browser'),
      trusted: trust === 'graded',
      isolation,
      trust,
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
