import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PYODIDE_VERSION,
  PYTHON_PACKAGE_CAPABILITY,
  describePythonError,
  isSelfHostedWasm,
  missingPythonPackage,
  pythonInitFiles,
  pythonMountPath,
  stdinBytes,
} from '../runners/browser/python-shared';

const NUMPY_ERROR =
  'Traceback (most recent call last):\n  File "<exec>", line 1, in <module>\n' +
  "ModuleNotFoundError: No module named 'numpy'\n" +
  "The module 'numpy' is included in the Pyodide distribution, but it is not installed.\n" +
  'You can install it by calling: await pyodide.loadPackage("numpy")';

describe('Python WASM 共享真值', () => {
  it('版本 pin 与 package.json 完全一致（js 胶水与 wasm 分发不能错版）', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    );
    expect(pkg.dependencies.pyodide).toBe(PYODIDE_VERSION);
    expect(PYODIDE_VERSION).toBe('314.0.7');
  });

  it('能力缺口如实登记：core 只有标准库，不声称能装第三方包', () => {
    expect(PYTHON_PACKAGE_CAPABILITY).toContain('stdlib-only');
    expect(PYTHON_PACKAGE_CAPABILITY).toContain('禁用自动装包');
  });

  it('附加文件挂载路径按净结果判逃逸', () => {
    expect(pythonMountPath('helper.py')).toBe('/pg/helper.py');
    expect(pythonMountPath('中文模块.py')).toBe('/pg/中文模块.py');
    for (const bad of [
      '',
      '   ',
      '../evil.py',
      'a/b.py',
      'a\\b.py',
      '.',
      '..',
      'a\x00.py',
      'a b.py',
      'a;rm.py',
    ]) {
      expect(pythonMountPath(bad), `应拒绝 ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('从 Pyodide 定制异常里提取缺失包名', () => {
    expect(missingPythonPackage(NUMPY_ERROR)).toBe('numpy');
    expect(missingPythonPackage("ModuleNotFoundError: No module named 'totally_fake_pkg_xyz'")).toBe(
      'totally_fake_pkg_xyz',
    );
    expect(missingPythonPackage('ValueError: 刻意报错')).toBeNull();
  });

  it('第三方包错误翻译成人话，并明确不外联；其它异常原样保留', () => {
    const described = describePythonError(NUMPY_ERROR);
    expect(described).toContain('第三方包 numpy');
    expect(described).toContain('不会向 CDN');
    expect(described).not.toContain('Traceback');
    expect(describePythonError('ValueError: 刻意报错')).toBe('ValueError: 刻意报错');
  });

  it('初始化文件跳过主脚本、滤掉非法路径', () => {
    const files = [
      { name: 'main.py', content: 'print(1)' },
      { name: 'helper.py', content: 'def f(): pass' },
      { name: '../evil.py', content: 'x' },
      { name: 'notes.txt', content: '   ' },
    ];
    expect(pythonInitFiles(files).map((f) => f.name)).toEqual(['helper.py', 'notes.txt']);
  });

  it('stdin 按 UTF-8 字节喂给 setStdin({read})', () => {
    const bytes = stdinBytes('昆明\n第二行\n');
    expect(new TextDecoder().decode(bytes)).toBe('昆明\n第二行\n');
    expect(bytes.length).toBeGreaterThan('昆明\n第二行\n'.length);
  });

  it('自托管判定：同源 URL 通过，公共 CDN 一律拒绝', () => {
    const origin = 'http://127.0.0.1:5173';
    expect(isSelfHostedWasm(`${origin}/pyodide/pyodide.asm.wasm`, origin)).toBe(true);
    expect(isSelfHostedWasm('https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.asm.wasm', origin)).toBe(false);
    expect(isSelfHostedWasm('https://unpkg.com/pyodide@314.0.7/pyodide.asm.wasm', origin)).toBe(false);
  });
});
