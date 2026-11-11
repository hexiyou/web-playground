import type { LangId, RunFile } from './contract';

export interface Sample {
  files: RunFile[];
  hint: string;
}

/** CSS 语言的内置示例 DOM。用户可提供第二个文件 index.html 覆盖它。 */
export const CSS_SKELETON = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style data-playground-css></style>
</head><body>
<main class="card">
  <h1>卡片标题</h1>
  <p>这是一段用于验证 CSS 的示例正文，中文应该正常显示。</p>
  <button type="button">示例按钮</button>
</main>
</body></html>`;

export const SAMPLES: Record<LangId, Sample> = {
  javascript: {
    files: [
      {
        name: 'main.js',
        content: `const nums = [1, 2, 3, 4, 5];
const sum = nums.reduce((a, b) => a + b, 0);

console.log('你好，playground');
console.log('sum =', sum);
console.log('stdin =', JSON.stringify(stdin));

// 定义了 main() 时，它的返回值会自动追加到输出
function main() {
  return { doubled: nums.map((n) => n * 2) };
}
`,
      },
    ],
    hint: '默认跑在 Worker 里（可 terminate 无限循环）；需要 document / canvas 时切到 iframe。',
  },
  typescript: {
    files: [
      {
        name: 'main.ts',
        content: `type Item = { name: string; qty: number };

const cart: Item[] = [
  { name: '咖啡', qty: 2 },
  { name: '茶', qty: 1 },
];
const total: number = cart.reduce((s, it) => s + it.qty, 0);

console.log('明细：', cart.map((i) => i.name + ' x' + i.qty).join('、'));
console.log('合计：', total);
`,
      },
    ],
    hint: '用 TypeScript 官方 transpileModule 转译，只做语法转换不做类型检查。',
  },
  html: {
    files: [
      {
        name: 'index.html',
        content: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8">
<style>
  body { font: 14px/1.7 system-ui, sans-serif; background: #f7f7f5; margin: 0; padding: 24px; }
  .card { background: #fff; border: 1px solid #e3e1da; border-radius: 10px; padding: 16px 20px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
</style>
</head>
<body>
  <div class="card">
    <h1>你好，playground</h1>
    <p id="msg">等待脚本执行…</p>
  </div>
  <script>
    console.log('HTML 已渲染');
    document.getElementById('msg').textContent =
      '脚本执行成功 · ' + new Date().toLocaleTimeString();
  </script>
</body>
</html>
`,
      },
    ],
    hint: '跑在 sandbox="allow-scripts" 的 iframe 里，不给 allow-same-origin。',
  },
  lua: {
    files: [
      {
        name: 'main.lua',
        content: `-- Lua 5.4 · wasmoon WASM 运行时（glue.wasm 自托管）
local nums = { 1, 2, 3, 4, 5 }
local sum = 0
for _, n in ipairs(nums) do
  sum = sum + n
end

print('你好，playground')
print('sum =', sum)
print('stdin 长度 =', #stdin)
print('tostring({}) =', tostring({}))

-- io.read() 读的是契约注入的 stdin；第二个 .lua 文件会挂到内存 FS，
-- 可以用 dofile('/helper.lua') 加载。顶层 return 的标量会回显到输出区。
return sum * 2
`,
      },
    ],
    hint: '跑在独立 module Worker 里（wasmoon 1.16.0 / Lua 5.4），glue.wasm 自托管不走 CDN；无真实网络与文件 IO。',
  },
  css: {
    files: [
      {
        name: 'style.css',
        content: `body { background: #f7f7f5; padding: 24px; }
.card {
  background: #ffffff;
  border: 1px solid #e3e1da;
  border-left: 3px solid #185fa5;
  border-radius: 10px;
  padding: 16px 20px;
  max-width: 420px;
}
.card h1 { color: #185fa5; font-size: 20px; }
.card button { background: #185fa5; color: #fff; border: 0; padding: 8px 14px; border-radius: 6px; }
`,
      },
    ],
    hint: '默认配一份内置 HTML 骨架；再加一个 index.html 文件即可换成自己的 DOM。',
  },
};
