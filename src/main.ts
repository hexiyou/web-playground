import './style.css';
import type { EditorView } from '@codemirror/view';
import {
  DEFAULT_LIMITS,
  SAMPLES,
  capabilityFor,
  deriveCapabilities,
  execute,
  statusLabel,
  validateWiring,
} from './core';
import type {
  BrowserSandbox,
  Capability,
  ExecTarget,
  LangId,
  RunResult,
} from './core/contract';
import type { ExecuteHandle } from './core/execute';
import { createRegistry, createLocalRunner } from './runners';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`页面缺少 #${id}`);
  return el as T;
}

const langSel = $<HTMLSelectElement>('lang');
const sandboxSel = $<HTMLSelectElement>('sandbox');
const targetSel = $<HTMLSelectElement>('target');
const wallInput = $<HTMLInputElement>('wall');
const runBtn = $<HTMLButtonElement>('run');
const cancelBtn = $<HTMLButtonElement>('cancel');
const statusEl = $<HTMLSpanElement>('status');
const hintEl = $<HTMLDivElement>('hint');
const editorEl = $<HTMLDivElement>('editor');
const outputEl = $<HTMLDivElement>('output');
const previewEl = $<HTMLDivElement>('preview');
const fileNameEl = $<HTMLSpanElement>('file-name');
const metaEl = $<HTMLSpanElement>('meta');
const capsBody = $<HTMLTableElement>('caps').tBodies[0];
const wiringEl = $<HTMLDivElement>('wiring');
const selftestEl = $<HTMLDivElement>('selftest');

/**
 * v0.5：服务端 runner 由调用方注入实例。默认接 A′ 本机进程节点（非 Docker），
 * 将来切官方 Piston 只需把这一行换成 createPistonRunner({...})，其余零改动。
 * 可用 ?server=<url>&token=<token> 覆盖，方便 dev/dist 两层与手动联调。
 */
const qs = new URLSearchParams(location.search);
const serverUrl = qs.get('server') || 'http://127.0.0.1:2000';
const serverToken = qs.get('token') || 'pg-local-dev-token';
const registry = createRegistry(() => previewEl, [
  createLocalRunner({ baseUrl: serverUrl, token: serverToken }),
]);
let capabilities: Capability[] = deriveCapabilities(registry);

const buffers = new Map<LangId, string>(
  (Object.keys(SAMPLES) as LangId[]).map((lang) => [lang, SAMPLES[lang].files[0].content]),
);
let currentLang: LangId = 'javascript';
let editor: EditorView | null = null;
let activeHandle: ExecuteHandle | null = null;

function currentCap(): Capability {
  return capabilityFor(capabilities, currentLang);
}

function renderTruth(): void {
  capsBody.replaceChildren();
  for (const cap of capabilities) {
    const tr = document.createElement('tr');
    const cells: (string | Node)[] = [
      `${cap.label} (${cap.lang})`,
      cap.runnerIds.join(', ') || '—',
      cap.targets.join(' / ') || '无',
      cap.prefer ?? '无',
      cap.offline ? '是' : '否',
      cap.isolation.join(' / ') || '无',
      cap.trust === 'graded' ? 'graded（可判分）' : cap.trust === 'advisory' ? 'advisory（仅参考）' : '无',
      cap.trusted ? '是' : '否',
      '',
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      if (typeof cell === 'string') td.textContent = cell;
      td.append(cell instanceof Node ? cell : document.createTextNode(''));
      if (typeof cell === 'string' && cell === '') {
        const tag = document.createElement('span');
        tag.className = `tag ${cap.available ? 'ok' : 'off'}`;
        tag.textContent = cap.available ? '可用' : '未接线';
        tag.title = cap.reason ?? '';
        td.replaceChildren(tag);
      }
      tr.appendChild(td);
    }
    capsBody.appendChild(tr);
  }

  const problems = validateWiring(registry, capabilities);
  wiringEl.className = `wiring${problems.length ? ' bad' : ''}`;
  wiringEl.textContent = problems.length
    ? `接线自检失败：${problems.join('；')}`
    : '接线自检通过：能力表声称可用的语言，注册表里都有已启用且 run 是函数的 runner。';
}

function renderLangOptions(): void {
  langSel.replaceChildren();
  for (const cap of capabilities) {
    const opt = document.createElement('option');
    opt.value = cap.lang;
    opt.textContent = cap.available ? cap.label : `${cap.label}（未接线）`;
    opt.disabled = !cap.available;
    opt.title = cap.reason ?? '';
    langSel.appendChild(opt);
  }
  langSel.value = currentLang;
}

function renderSandboxOptions(): void {
  const cap = currentCap();
  sandboxSel.replaceChildren();
  // 纯服务端语言（Go / PHP / Perl / R）没有浏览器载体，如实显示「仅服务端」而不是伪造 Worker/iframe 选项。
  if (cap.switchable.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '仅服务端';
    sandboxSel.appendChild(opt);
    sandboxSel.value = '';
    sandboxSel.disabled = true;
    return;
  }
  for (const s of cap.switchable) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s === 'worker' ? 'Worker（可杀循环）' : 'iframe（有 DOM）';
    sandboxSel.appendChild(opt);
  }
  sandboxSel.value = cap.browserSandbox;
  sandboxSel.disabled = cap.switchable.length < 2;
}

function renderTargetOptions(): void {
  const cap = currentCap();
  for (const opt of Array.from(targetSel.options)) {
    if (opt.value === '') continue;
    opt.disabled = !cap.targets.includes(opt.value as ExecTarget);
    opt.title = opt.disabled ? '该位置当前未接线，选择后会被明确拒绝（不静默降级）' : '';
  }
  if (targetSel.selectedOptions[0]?.disabled) targetSel.value = '';
}

async function languageExtension(lang: LangId) {
  if (lang === 'javascript') {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript();
  }
  if (lang === 'typescript') {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript({ typescript: true });
  }
  if (lang === 'html') {
    const { html } = await import('@codemirror/lang-html');
    return html();
  }
  if (lang === 'lua') {
    const [{ StreamLanguage }, { lua }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/lua'),
    ]);
    return StreamLanguage.define(lua);
  }
  if (lang === 'sql') {
    const { sql } = await import('@codemirror/lang-sql');
    return sql();
  }
  if (lang === 'python') {
    const { python } = await import('@codemirror/lang-python');
    return python();
  }
  if (lang === 'go') {
    const [{ StreamLanguage }, { go }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/go'),
    ]);
    return StreamLanguage.define(go);
  }
  if (lang === 'php') {
    // legacy-modes 里没有 PHP（CM5 的 php 是混合模式，被排除），用官方 lang-php。
    const { php } = await import('@codemirror/lang-php');
    return php();
  }
  if (lang === 'perl') {
    const [{ StreamLanguage }, { perl }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/perl'),
    ]);
    return StreamLanguage.define(perl);
  }
  if (lang === 'r') {
    const [{ StreamLanguage }, { r }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/r'),
    ]);
    return StreamLanguage.define(r);
  }
  const { css } = await import('@codemirror/lang-css');
  return css();
}

/** 编辑器懒加载：CodeMirror 与语言包都不进首屏。 */
async function mountEditor(lang: LangId): Promise<void> {
  const [{ EditorView, basicSetup }, { EditorState }, extension] = await Promise.all([
    import('codemirror'),
    import('@codemirror/state'),
    languageExtension(lang),
  ]);
  const langAtMount = lang;
  const content = buffers.get(langAtMount) ?? '';
  if (editor) {
    editor.destroy();
    editor = null;
  }
  editor = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        extension,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) buffers.set(langAtMount, u.state.doc.toString());
        }),
      ],
    }),
    parent: editorEl,
  });
}

async function setLanguage(lang: LangId): Promise<void> {
  if (editor) buffers.set(currentLang, editor.state.doc.toString());
  currentLang = lang;
  const sample = SAMPLES[lang];
  hintEl.textContent = sample.hint;
  fileNameEl.textContent = sample.files[0].name;
  renderSandboxOptions();
  renderTargetOptions();
  await mountEditor(lang);
}

function clearPreview(): void {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = 'HTML / CSS，或 JS 切到 iframe 载体时在这里渲染。';
  previewEl.replaceChildren(empty);
}

function renderResult(result: RunResult): void {
  outputEl.replaceChildren();
  if (result.outputs.length === 0 && result.diagnostics.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = '本次运行没有输出。';
    outputEl.appendChild(div);
  }
  for (const chunk of result.outputs) {
    const line = document.createElement('div');
    line.className = `line ${chunk.stream}`;
    const seq = document.createElement('span');
    seq.className = 'seq';
    seq.textContent = String(chunk.seq).padStart(2, '0');
    line.append(seq, document.createTextNode(chunk.text));
    outputEl.appendChild(line);
  }
  for (const d of result.diagnostics) {
    const div = document.createElement('div');
    div.className = `diag ${d.level}`;
    div.textContent = `[${d.level}${d.code ? '/' + d.code : ''}] ${d.message}`;
    outputEl.appendChild(div);
  }
  outputEl.scrollTop = outputEl.scrollHeight;

  const probeText = result.probes
    ? Object.entries(result.probes)
        .map(([k, v]) => `${k}=${v.slice(0, 40)}`)
        .join(' · ')
    : '';
  metaEl.textContent = [
    result.engine ?? '未执行',
    result.target ?? '—',
    result.exitCode === null ? '无退出码语义' : `exit ${result.exitCode}`,
    `${result.durationMs} ms`,
    probeText,
  ].filter(Boolean).join(' · ');

  statusEl.className = `status ${result.status === 'ok' ? 'ok' : 'bad'}`;
  statusEl.textContent = statusLabel(result.status);
}

async function doRun(): Promise<void> {
  if (activeHandle) return;
  const cap = currentCap();
  const source = editor ? editor.state.doc.toString() : (buffers.get(currentLang) ?? '');
  buffers.set(currentLang, source);
  clearPreview();
  outputEl.replaceChildren();
  statusEl.className = 'status';
  statusEl.textContent = '运行中…';
  runBtn.disabled = true;
  cancelBtn.disabled = false;

  const sandbox: BrowserSandbox | undefined =
    cap.switchable.length > 1 ? (sandboxSel.value as BrowserSandbox) : undefined;
  const target: ExecTarget | undefined =
    targetSel.value === '' ? undefined : (targetSel.value as ExecTarget);

  const request = {
    language: currentLang,
    files: [{ name: SAMPLES[currentLang].files[0].name, content: source }],
    stdin: '',
    limits: { ...DEFAULT_LIMITS, wallMs: Number(wallInput.value) || DEFAULT_LIMITS.wallMs },
    ...(target ? { target } : {}),
    ...(sandbox ? { sandbox } : {}),
  };

  const handle = execute(request, registry);
  activeHandle = handle;
  try {
    const result = await handle.result;
    renderResult(result);
  } finally {
    activeHandle = null;
    runBtn.disabled = false;
    cancelBtn.disabled = true;
  }
}

async function main(): Promise<void> {
  capabilities = deriveCapabilities(registry);
  renderTruth();
  renderLangOptions();
  hintEl.textContent = SAMPLES[currentLang].hint;
  fileNameEl.textContent = SAMPLES[currentLang].files[0].name;
  renderSandboxOptions();
  renderTargetOptions();
  await mountEditor(currentLang);

  langSel.addEventListener('change', () => void setLanguage(langSel.value as LangId));
  runBtn.addEventListener('click', () => void doRun());
  cancelBtn.addEventListener('click', () => activeHandle?.cancel());
  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      void doRun();
    }
  });

  if (new URLSearchParams(location.search).has('selftest')) {
    selftestEl.hidden = false;
    const mod = await import('./tests/selftest');
    const report = await mod.runSelftest(registry, DEFAULT_LIMITS);
    mod.renderReport(report, selftestEl);
  }
}

void main();
