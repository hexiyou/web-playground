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
  sql: {
    files: [
      {
        name: 'main.sql',
        content: `-- SQLite 3.54 · sql.js WASM（wasm 自托管，不走 CDN）
CREATE TABLE orders (id INTEGER, city TEXT, amount REAL, note TEXT);
INSERT INTO orders VALUES
  (1, '昆明', 128.5, NULL),
  (2, '成都', 76.0, '已付'),
  (3, '昆明', 210.0, NULL);

SELECT city, COUNT(*) AS cnt, SUM(amount) AS total
FROM orders
GROUP BY city
ORDER BY total DESC;

-- 别名撞上 SQLite 关键字（NOTHING / DO / KEY…）必须加引号，否则 prepare 阶段就报语法错误。
SELECT sqlite_version() AS sqlite, '中文标记' AS label, NULL AS "nothing";

-- 同一次运行内多语句共享同一个 DB；再加一个 .sql 文件会作为初始化脚本先执行。
-- 结果集逐行读回，输出字节 / 行数触顶即停；无限递归 CTE 靠 Worker terminate 真杀。
`,
      },
    ],
    hint: '跑在独立 module Worker 里（sql.js 1.16.0 / SQLite 3.54），wasm 自托管不走 CDN；附加 .sql 文件作初始化脚本。无 allocator 内存上限，只有墙钟 + 输出字节 + 行数上限。',
  },
  python: {
    files: [
      {
        name: 'main.py',
        content: `# CPython 3.14 · Pyodide WASM（core 分发自托管，不走 CDN）
import json
import statistics

nums = [1, 2, 3, 4, 5]
print('你好，playground')
print('sum =', sum(nums), 'mean =', statistics.mean(nums))
print('json =', json.dumps({'城市': '昆明', 'nums': nums}, ensure_ascii=False))

# input() 读的是契约注入的 stdin（UI 暂未暴露输入框，自检里已验过多行读回）。
# 再加一个 .py 文件会挂到 /pg/，可以 import helper。
# 首版只有标准库：core 分发没有 wheel / micropip，import 第三方包会给可读错误，绝不外联。
sum(nums) * 2
`,
      },
    ],
    hint: '跑在独立 module Worker 里（Pyodide 314.0.7 / CPython 3.14.2），core 分发自托管不走 CDN；仅标准库，第三方包需预置 wasm wheel。无网络 / socket / threading / 子进程。',
  },
  go: {
    files: [
      {
        name: 'main.go',
        content: `// Go · 本机工具链（A′ 执行节点，非 Docker；仅标准库，GOPROXY=off）
// 只有 server 位置能跑：先 npm run server 启动本地节点，再点运行。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func main() {
	nums := []int{1, 2, 3, 4, 5}
	sum := 0
	for _, n := range nums {
		sum += n
	}

	fmt.Println("你好，playground")
	fmt.Println("sum =", sum)

	scanner := bufio.NewScanner(os.Stdin)
	line := ""
	if scanner.Scan() {
		line = scanner.Text()
	}
	fmt.Println("stdin =", line)

	payload, _ := json.Marshal(map[string]any{"城市": "昆明", "nums": nums})
	fmt.Println("json =", string(payload))
	fmt.Println("upper =", strings.ToUpper("go ok"))

	// 再加一个 .go 文件会写进同一临时模块目录，一起 go build。
	// 编译与运行分两阶段；进程级超时/输出限额，没有内核级隔离。
}
`,
      },
    ],
    hint: '仅服务端执行：先 npm run server 启动本机 Go 执行节点（非 Docker、只绑 127.0.0.1）。go build + 运行两阶段，仅标准库且强制 GOPROXY=off 不外联；结果仅参考、不可用于判分。',
  },
  php: {
    files: [
      {
        name: 'main.php',
        content: `<?php
// PHP · 本机解释器（A′ 执行节点，非 Docker；仅服务端，单阶段无 compile）
$nums = [1, 2, 3, 4, 5];
$sum = array_sum($nums);

echo "你好，playground\\n";
echo "sum = " . $sum . "\\n";

$line = fgets(STDIN);
echo "stdin = " . trim($line === false ? '' : $line) . "\\n";

echo "json = " . json_encode(['城市' => '昆明', 'nums' => $nums], JSON_UNESCAPED_UNICODE) . "\\n";
echo "upper = " . strtoupper('php ok') . "\\n";

// 再加一个 .php 文件会写进同一临时目录，主文件里 require 'helper.php' 即可。
// 节点按 -d allow_url_fopen=0 关掉 URL 包装器，php.ini 用宿主机默认；
// 没有内核级隔离，curl / sockets 扩展仍可联网。结果仅参考、不可用于判分。
`,
      },
    ],
    hint: '仅服务端执行：先 npm run server 启动本机执行节点。单阶段解释执行（无 compile 阶段），启动几十毫秒；附加 .php 文件同目录可 require。节点每次动态探测本机 PHP，未安装或不就绪会自动置灰，可在 servers/local/runtimes.local.json 里给便携式 PHP 配绝对路径。结果仅参考、不可用于判分。',
  },
  perl: {
    files: [
      {
        name: 'main.pl',
        content: `use strict;
use warnings;
use utf8;
binmode(STDOUT, ':encoding(UTF-8)');
use Cwd qw(getcwd);
use JSON::PP;

my @nums = (1, 2, 3, 4, 5);
my $sum = 0;
$sum += $_ for @nums;

print "你好，playground\\n";
print "sum = $sum\\n";

my $line = <STDIN>;
chomp $line if defined $line;
print "stdin = ", (defined $line ? $line : ''), "\\n";

print "json = ", JSON::PP->new->encode({ 城市 => '昆明', nums => \\@nums }), "\\n";
print "upper = ", uc('perl ok'), "\\n";
print "OS = $^O\\n";
print "cwd = ", getcwd(), "\\n";

# 本机走 Cygwin Perl：可执行文件由 servers/local/runtimes.local.json 配绝对路径，
# 不在 PATH、也没写注册表。$^O 是 cygwin，getcwd() 返回 /cygdrive/c/...，
# 路径分隔符是 / —— 和 Git Bash 的 MSYS2 是两套 POSIX 运行时，别混用 /tmp 之类路径。
# 中文必须 use utf8 + binmode(STDOUT, ':encoding(UTF-8)') 配套；
# 只写 binmode ':utf8' 会把 UTF-8 字节当 Latin-1 升级，输出变乱码。
# 附加 .pl 文件写进同一临时目录；节点加了 -I. 才能 require 'helper.pl'
# （Perl 5.26+ 把 . 从 @INC 移除了）。没有内核级隔离，结果仅参考、不可用于判分。
`,
      },
    ],
    hint: '仅服务端执行：先 npm run server 启动本机执行节点。本机用 Cygwin Perl 5.32（非原生 Windows Perl），路径写在 servers/local/runtimes.local.json 的 perl.path；节点每次动态探测并把 $^O 如实登记到 probes.runtimeFlavor。中文要 use utf8 + binmode 编码层配套。结果仅参考、不可用于判分。',
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
