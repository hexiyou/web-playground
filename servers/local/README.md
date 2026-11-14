# A′ 本地执行节点 · 真值手册

> 本文件 + 仓库根 `playground-architecture-analysis.html` 第十三章 + `src/core/contract.ts`
> 是本节点的三份真值。**动手改之前先读「决策分叉」一节。**
>
> v0.6 变更：节点从「写死只跑 Go」改成**内建 runtimeSpec 表 + 每次真探测 + 可配置运行时路径**，
> 并接入第二门服务端语言 **PHP**。加下一门语言不再改 `execute()` 分支。
>
> v0.7 变更：接入第十门语言 **Perl**（本机是 **Cygwin Perl 5.32**，不是原生 Windows Perl），
> 第一次真正用「手动配置运行时路径」挂**不在 PATH、没写注册表**的便携式解释器；新增
> `flavor` 字段由 `$^O` 动态探测，不硬编码宿主。**Cygwin 环境实测报告与完整坑清单见 §8** ——
> 后续要接 MSYS2 / WSL / 其它 POSIX 风味运行时之前，务必先读那一节。
>
> v0.8 变更：接入第十一门语言 **R**（本机是 **Cygwin R 4.2.1**）。与 Perl 不同，
> `D:\cygwin64\bin\r` 的入口**本质是 `#!/bin/sh` 脚本，不是可执行文件** ⇒ 节点新增通用
> `wrapEntry`（同目录 `sh.exe <script>` 包装）与 `envFromTool`（干净 PATH/HOME、剥宿主
> `BASH_FUNC_*` 导出函数）两项能力；`execute()` 仍然零语言分支。
> **脚本型入口实测与坑清单见 §9** —— 后续要挂任何 shebang wrapper / 便携版 launcher
> 之前，务必先读 §8 + §9 + §10 三节。
>
> v0.9 变更：接入第十二门语言 **Ruby**（本机是 **RubyInstaller 4.0.9 / x64-mingw-ucrt**）。
> 与 Perl / R 都不同：入口是**原生 PE 可执行文件、且就在 PATH 里**，`ruby.path` 留空即可，
> 既不需要 `wrapEntry` 也不需要 `envFromTool`。节点只剥宿主 Ruby/gem 变量，并如实登记
> Windows 原生 `puts` 的 CRLF（不归一化）。**实测与坑清单见 §10**。

## 1. 这是什么 / 为什么与官方推荐分叉

官方 Piston 推荐的部署是 `docker run --privileged`（或 compose 里 `privileged: true`），
要求**纯 cgroup v2 + v1 关闭**，原理是 `Isolate inside Docker`（Linux namespaces / chroot /
多个非特权 uid / cgroup）。`api/src/docker-entrypoint.sh` 会直接写
`/sys/fs/cgroup/isolate/cgroup.procs` 与 `cgroup.subtree_control`，这正是它必须跑在特权
容器里的原因，也是它**不能 Windows 原生跑、不能脱离 Docker 官方支持**的原因。

本项目 v0.5 起刻意选了另一条路：**A′ 本机进程执行节点**，Go 单二进制、非 Docker、
跨平台、只绑回环地址。分叉依据是**威胁模型不同**，不是偷懒：

| | 官方 Piston | 本项目 A′ |
|---|---|---|
| 面向 | 任意陌生人的恶意代码 | 团队内几个人、自己写的可信片段 |
| 隔离 | isolate（内核级）+ Docker privileged | 进程级：墙钟 + 输出字节 + 并发 + 临时目录 |
| 结果可信度 | `graded`，可判分 | **`advisory`，不可判分** |
| 部署 | Linux + Docker + cgroup v2 + root | Windows / Linux / macOS，单二进制，零特权 |
| 语言运行时 | 容器内 `/piston/packages`，`ppman install` 装预编译包 | **宿主机**：PATH 里找，或配置里给绝对路径 |
| 网络 | 默认禁 socket syscall | 按语言尽力而为（Go `GOPROXY=off` / PHP 关 URL 包装器），**运行期没有内核级禁网** |

**因此 A′ 的硬边界（改任何一条前先重新评估威胁模型）**：

1. **只绑 `127.0.0.1`**。`-addr` 传非回环地址会直接拒绝启动。需要跨机访问 ≠ 加个
   `0.0.0.0` 就完事，那等于把「能执行任意本机代码」的接口开放出去。
2. **默认 token 只是防本机其它页面误调，不是安全边界**。固定值
   `pg-local-dev-token`、前端默认带同一个值，是「开发口令」而非凭据。
3. **代码可信是前提**。节点没有内核隔离：用户代码能读本机文件、起子进程、联网。
   一旦要跑不可信代码、对外开放、或用于判分，**必须切回官方 Docker + isolate**。
4. 能力表如实登记 `isolation: process-only` / `trust: advisory`，
   `RunResult.usage.memoryBytes` 不填（不拿 0 冒充用量）。**不许因为 `target: server`
   就把它标成可信** —— v0.5 为此专门改了 `deriveCapabilities()`。

## 2. 起停与构建

```bash
npm run server                     # 前台启动；自动按需 go build
node scripts/local-server.mjs      # 同上
npm run check:node                 # 节点层判据：配置路径 / 动态探测 / disabled / PATH 回退
npm run smoke                      # 自动拉起/复用/关闭节点，跑真机自检
```

- 二进制落在 `servers/local/bin/playground-local(.exe)`，**不入库**（`.gitignore` 已排）。
- `scripts/local-server.mjs` 会先探活 `/health`：若 2000 端口已有节点在线则**复用**，
  结束时不会误杀何工手动开着的进程。⚠️ 改完 `main.go` 后若旧节点还挂在 2000，
  复用的是旧二进制 —— 验收前先停掉旧节点，或换 `PLAYGROUND_SERVER_PORT`。
- 参数：`-addr`（默认 `127.0.0.1:2000`）、`-token`（空串关闭鉴权，不推荐）、
  `-max-parallel`（默认 4）、`-config`（运行时配置文件，见 §3）。
  环境变量：`PLAYGROUND_SERVER_PORT`、`PLAYGROUND_SERVER_TOKEN`、
  `PLAYGROUND_RUNTIMES_CONFIG`。
- 前端默认 `?server=<url>&token=<token>` 可覆盖（见 `src/main.ts`）。
- **宿主前置条件（四层，缺一层能力表就置灰）**：① 本机有 `go`（节点自身用
  `go build` 编译，且 Go 语言用它）；② 目标语言的解释器/编译器在 PATH 或配置里指到；
  ③ 节点内建 `builtinSpecs()` 里有该语言的 spec（装了解释器但没写 spec 照样不登记）；
  ④ 每台机器都要装，版本 / 扩展 / `php.ini` 不一致 ⇒ 无可复现性。

## 3. 运行时路径配置与动态探测（v0.6）

### 3.1 配置文件

节点启动时按 **`runtimes.local.json` → `runtimes.json`** 顺序找第一个存在的；
`-config` / `PLAYGROUND_RUNTIMES_CONFIG` 显式指定时，文件不存在会**直接报错**，不静默回退。

- `servers/local/runtimes.json`：**入库模板**，`path` 留空表示走 PATH。
- `servers/local/runtimes.local.json`：**本机覆盖、不入库**（`.gitignore` 已排），
  用来写便携式运行时的绝对路径。配置里的相对路径在加载时就转成绝对路径 ——
  执行阶段 `cmd.Dir` 是临时目录，相对路径会失效。

```json
{
  "runtimes": {
    "go":   { "path": "", "disabled": false },
    "php":  { "path": "D:/portable/php-8.3/php.exe", "disabled": false },
    "perl": { "path": "D:/cygwin64/bin/perl.exe", "disabled": false }
  }
}
```

`perl` 这条是 v0.7 的真实用例：Cygwin Perl **不在 PATH、没写注册表**，靠绝对路径挂进来。
`check:node` 的 `fallback/perl-follows-path-truth` 会反证：把 `path` 清空后，PATH 里没有
perl ⇒ 该语言从 `runtimes` 消失，**证明它全靠配置、不是碰巧被 LookPath 找到**。

| 字段 | 含义 |
|---|---|
| `path` | 可执行文件绝对路径（可相对节点 cwd）。空串 = `exec.LookPath(execName)` 回退 PATH |
| `disabled` | `true` = **显式关闭，优先级最高**；即使 PATH 里有也不登记 |

配置里出现内建 spec 没有的语言键会打日志警告后忽略（防拼写错误），**不会凭空多出一门语言**。
配置只在启动时读一次；改完要重启节点。`GET /health` 会回报当前生效的 `config` 文件名。

### 3.2 动态探测 = 能力表照「这一刻能不能跑」报

`GET /api/v2/runtimes` **每次请求都真探测**（不缓存、不硬编码版本号）：

```
对 builtinSpecs() 里每条 spec：
  disabled?        → 跳过（「关」必须是第一句）
  path 配了?       → os.Stat 必须是普通文件，否则跳过；source = "config"
  path 为空?       → exec.LookPath(execName)，找不到就跳过；source = "path"
  找到可执行文件  → 带 3s 超时跑 detectArgs，正则解析版本；失败就跳过
                   → 若 spec 配了 flavorRe，从同一次输出再解析宿主风味（如 perl 的 $^O）
```

`detectArgs / versionRe / flavorRe` 都由 spec 描述。**宿主风味不猜、不硬编码**：Perl 的
探测命令一次输出 `$^V|$^O`（如 `v5.32.1|cygwin`），`runtimes[].flavor` 与
`probes.runtimeFlavor` 都如实回报。同一条 spec 换挂 Strawberry Perl（`MSWin32`）、
ActivePerl 或 Linux perl 时，只有 flavor 变，节点代码一行不用改。

探测失败的语言**不出现在数组里**，前端 `RuntimeCache` 拿到版本表后，缺哪门就把哪门
判为 `unavailable` 并给出「安装到 PATH 或配 `runtimes.local.json`」的指引；能力表由注册表
推导，注册表声明的语言仍在，但真跑时如实报不可用 —— **绝不静默降级到 browser**。
探测失败的原因只写进 `GET /health` 的 `missing` 字段，不污染 Piston v2 线协议。

`POST /api/v2/execute` 也会重探测一次再跑：便携式 U 盘被拔走后，不会拿旧路径去执行。

### 3.3 加一门语言的节点侧改动

`builtinSpecs()` 里加一条 `runtimeSpec`：`language / aliases / execName / detectArgs /
versionRe / flavorRe / extensions / entryName / envStrip / envSet / probeExtra /
prepare / compile / run`，v0.8 起再加两个可选钩子：
`wrapEntry(tool) *launcher` 与 `envFromTool(tool) []string`。
`flavorRe` 可选，用来从探测输出里解析宿主风味（不硬编码）。
`compile` 为 `nil` 就是单阶段语言（PHP / Perl / R），非 nil 走编译 + 运行两阶段（Go）。

- **`wrapEntry`**：入口不是 PE 而是 shebang 脚本时（Cygwin R 的 `#!/bin/sh`），Windows
  `CreateProcess` 直接 exec 会报 `WinError 193`。spec 返回一个 `launcher{name, argv}`，
  真正 exec 的是 `launcher.name`，参数为 `launcher.argv + plan.argv`。
  ★ **探测与执行必须共用同一个包装**：`resolveRuntime()` 跑 `--version` 时也要包装 +
  用同一套 env，否则会出现「runtimes 能报出版本、真执行却 127」的假绿。
- **`envFromTool`**：给非原生运行时重建干净环境（PATH / HOME / CYGWIN），
  再由 `stageEnv()` 按 `envStrip` 剥宿主变量；变量名一律 `ToUpper` 归一化，
  并**无条件剥掉 `BASH_FUNC_` 前缀**（详见 §9）。

文件名白名单、环境净化、`go.mod` 生成、启动参数都由 spec 描述，`execute()` 里没有
任何 `if language == ...` 分支。前端仍按固定五步（登记 → Runner 映射 → 注入 →
CodeMirror → 判据负例），**UI 一行不改**。

### 3.4 判据

`npm run check:node` 在独立端口（默认 2099，可 `PLAYGROUND_NODE_CHECK_PORT` 改）重启节点
五次，只押 HTTP 接口能看到的事实：

| 场景 | 押什么 |
|---|---|
| A 配了 `php.path` / `perl.path` / `r.path`，`ruby.path` 留空走 PATH | `source === "config"` · `health.config` 指向临时文件且 `missing={}` · 三门 execute 真吐出字节 · `perl.flavor === $^O` / `r.flavor` 来自 `--version` 的 Platform 行且版本一致 · 中文 UTF-8、Cygwin cwd/分隔符、LF 不转 CRLF · **R 的 `entryKind=shell-script;#!/bin/sh` / `wrapper=sh.exe <script>` / stderr 无 `safe-bin` 污染 / 不谎报默认包** · **Ruby 的 `source=path` / `entryKind=native-executable;no-wrapper` / CRLF 真值 / 宿主 `RUBYOPT` 净化** · Go 两阶段不回归 |
| B path 指向不存在 | php / perl / r 都从 runtimes 消失 · `health.missing` 说明原因 · 三门 `POST execute` 都明确 400 `runtime is unknown` |
| C `disabled: true` | PATH 里明明有 php / ruby、配置里明明有 perl 与 r，仍不登记（证明「关」优先于探测） |
| D `path: ""` | php / ruby 回退 PATH `source="path"` 且 execute 真跑通；**perl / r 按 PATH 里到底有没有它如实判**（本机都没有 ⇒ 不登记，反证 A 场景全靠配置路径） |
| E 包装器缺失 | 把 R 入口拷到没有 `sh.exe` 的临时目录 ⇒ r 不登记、`health.missing` 明写「脚本包装器不可用」、execute 400。**反证 `wrapEntry` 不是摆设** |

v0.9 共 **62 条**（node 6 · config 36 · badpath 7 · disabled 5 · fallback 5 · wrapper 3；v0.8 是 46 条，v0.7 是 26 条）。
D 场景那条是「手动配置运行时路径」的价值证据：Cygwin Perl / R 都不在 PATH，
清空 `path` 后能力表必须立刻置灰，不许拿缓存里的旧路径假装还能跑；Ruby 则是「PATH 直发现」的正向证据（`source=path` 与 `disabled` 优先各有判据）；E 场景是「脚本型入口」
的价值证据：入口能 `os.Stat` 到 ≠ 能启动，包装器不在就必须置灰。

报告落在 `.node-check-report.json`（不入库）。**真机自检（浏览器 CDP）只证明前端资产零外联，
证明不了节点进程的网络行为**，配置路径是否生效只能靠这一层判据。

## 4. HTTP 接口（Piston v2 兼容子集）

| 端点 | 说明 |
|---|---|
| `GET /health` | 探活，回报 engine / isolation / trust / `config` / `runtimes` / `missing` |
| `GET /api/v2/runtimes` | `[{language,version,aliases,source}]`，**只含这一刻能跑的语言** |
| `POST /api/v2/execute` | 请求/响应同 Piston v2 形状 |
| `OPTIONS *` | CORS 预检，204 |

`runtimes[].source`（`config` / `path`）与 `runtimes[].flavor`（如 `cygwin`）都是 A′ 扩展字段，
官方 Piston 没有；前端 `RuntimeCache` 只取 `language/version`，忽略其余字段即可。

请求体接受的字段：`language / version / files[] / stdin / args / compile_timeout /
run_timeout / compile_cpu_time / run_cpu_time / compile_memory_limit /
run_memory_limit`，另加 A′ 扩展字段 **`output_max_size`**（官方 Piston 由环境变量配置，
不传则忽略）。`files[].name` 按 Piston 契约只接受**纯文件名**（无路径、无分隔符），
扩展名按语言白名单：Go 只收 `.go`、PHP 只收 `.php`、Perl 只收 `.pl`、R 只收 `.R/.r`、Ruby 只收 `.rb`；`encoding` 只支持 `utf8`。
第一个文件是主文件；`name` 为空时按语言补 `main.go` / `main.php` / `main.pl` / `main.R` / `main.rb`。

响应体：`{language, version, run:{...}, compile?:{...}, probes:{...}}`。
**单阶段语言（PHP / Perl / R / Ruby）不带 `compile` 字段**，前端 `mapExecuteResponse()` 走编译缺省分支；
两阶段语言（Go）编译失败时 `compile.status = "RE"`，`run` 是空壳并带 `message`，
由 `compile.status` 决定总体状态，**不谎报执行过**。

**与官方 Piston 的差异（如实登记，不要当 bug 修）**：

- 六码 `status` 只产出 `RE / TO / OL / XX` 的子集；`SG`、`EL` 未实现。
- `cpu_time`、`memory` **不填**：Go 标准库跨平台拿不到子进程 CPU / 峰值内存，
  `probes` 里明写 `cpuTime=unavailable`、`memoryCapability=no-memory-cap`。
- `compile_cpu_time / run_cpu_time / *_memory_limit` 接收但**不执行**，
  只有墙钟、输出字节、并发上限是真闸（`probes.enforcedLimits` / `unsupportedLimits`）。
  `buildExecuteBody()` 仍然显式传这些字段，是为了将来切官方 Piston 时行为一致。
- `probes` 按语言登记：`stages=build+run|run`、`network`（见下）、
  `runtimePathSource=config|path`、`runtimeVersion`、可选的 `runtimeFlavor`（`flavorRe`
  配了才写）、Perl 的 `flavorFrom=$^O` / `includePath=-I.`、Ruby 的 `entryKind=native-executable;no-wrapper` / `lineEndings=no-normalization;platform-native`、`encoding=utf8-only`。

**各语言的零外联口径（别混）**：

| 语言 | 做法 | 仍然能联网的路径 |
|---|---|---|
| Go | `GOPROXY=off / GOTOOLCHAIN=local / GOSUMDB=off / GOWORK=off` 只管编译期拉包 | 用户代码里的 `net/http` 可直连 |
| PHP | `-d allow_url_fopen=0 -d allow_url_include=0` 关 URL 包装器；`php.ini` 用宿主机默认 | `curl` / `sockets` / `stream_socket_client` 扩展仍可直连 |
| Perl | **没有任何禁网措施**：只剥掉宿主的 `PERL5LIB` / `PERL5OPT` / `PERLLIB` / `PERL_LOCAL_LIB_ROOT` / `PERL_MM_OPT`，避免把本机模块带进执行环境 | `IO::Socket::INET` / `LWP` / `system()` / `fork()` 全可用；Cygwin 有完整 socket 栈，`probes.network=no-enforcement;IO::Socket-available` |
| Ruby | **没有任何禁网措施**：保留 PATH，只剥宿主 `RUBYOPT` / `RUBYLIB` / `RUBYPATH` / `GEM_*` / `BUNDLE_*` | `TCPServer` / `Net::HTTP` / `system()` 全可用，`probes.network=no-enforcement;TCPServer-available` |

⇒ **A′ 没有网络隔离**，这是「只跑可信代码」的又一条理由。别把 `-d allow_url_fopen=0`
当成沙箱。PHP 语法错误走 `display_errors=stderr` 进 stderr，进程退出码非零但
`run.status` 仍为 `null`（Piston 语义：进程自己退出不算引擎错误），判据要押
stderr + `exitCode`，不要押 `status=error`。

## 5. 已知坑（都踩过，别再踩回去）

1. **★★ Windows 管道 EOF**：`exec.Cmd` 用 `io.Writer` 做 stdio 时会建管道并起
   `io.Copy` goroutine，`go build` 的 compile/link 子进程继承句柄后，父进程退出
   `Wait()` 仍可能等 EOF。现在改用**真实 `*os.File`**，输出限额由「文件大小看门狗
   （超过 2×上限就 Kill）+ 读回截断」两层保证。`WaitDelay=250ms` 只作兜底。
2. **★★ 满 CPU 死循环在本机有环境开销**：实测 `for{}` 让 `go build` 慢约 6.3 秒、
   `TerminateProcess` 再慢约 5.4 秒；换成 `time.Sleep` 后分别是 1.5 秒 / 1.2 秒。
   这与管道无关，是本机 Windows 环境（安全软件/Defender 扫描新 exe）。
   ⇒ **超时判据只押 `status=TO` / `signal=SIGKILL`，不押 `wall_time` 毫秒数**；
   Go 自检用 `time.Sleep(30s)`、PHP 自检用 `sleep(30)`，都不用忙等。
3. **★ 服务端 Runner 不能直接返回 outputs**：`execute.ts` 是唯一入口，会用
   `collector.snapshot()` 覆盖 runner 返回的 `outputs`。v0.1~v0.4 服务端骨架从未真机
   接线，纯函数单测全绿却没人发现输出会被丢掉。现在由
   `emitServerResult()` 把纯函数的 outputs 逐条 `ctx.emit()`，输出字节限额仍归
   `collector` 统一收口；`local.test.ts` / `php.test.ts` 都有**连线层判据**押这件事。
4. **★ `go build -o` 与运行阶段必须用同一个 exeName**：v0.6 抽 spec 表时把 Windows
   `.exe` 后缀逻辑挪进 run plan，compile 仍写无后缀名 ⇒ 编译 `code=0` 却报
   `program.exe: The system cannot find the file specified`。现在后缀在 `execute()`
   里统一补一次，两个 plan 共用。手工 API 验证抓到的，单元判据抓不到。
5. **`go.mod` 的 `go` 指令按探测版本动态取前两段**（`1.27.0` → `go 1.27`），
   写死会要求下载新工具链。同时强制 `GOTOOLCHAIN=local`、`GOPROXY=off`、
   `GOSUMDB=off`、`GOWORK=off`、`CGO_ENABLED=0`，编译期零外联、不需要 gcc。
6. **进程树 kill 不保证**：Windows 上 `Process.Kill()` 只杀主进程，用户代码 fork 的
   子进程可能残留（`probes.processTreeKill=not-guaranteed-on-windows`）。
7. 每次执行新建独立临时目录并 `defer os.RemoveAll`，`go build` 无缓存复用，
   本机约 1.5 秒/次；真机自检窗口已从 90 秒放宽到 150 秒。
8. **配置里的相对路径必须在加载时转绝对**：执行时 `cmd.Dir` 是临时目录，
   直接拿 `./portable/php.exe` 去 `exec.Command` 必然找不到。
9. **CDP 抓包不是节点进程的网络证据**：浏览器只监听自己的 target，节点进程发的
   请求它一条也看不到。「零外联」判据证明的是前端资产同源自托管；节点侧只能靠
   `probes.network` 自述 + `check:node` 的行为判据，二者都不能替代内核隔离。
10. **★ Cygwin / 非原生 POSIX 运行时有一整组专属坑**（中文 argv 假象、UTF-8 编码层陷阱、
    `/cygdrive/` 路径语义、DLL 依赖靠 exe 同目录、`.` 不在 `@INC`、进程树 kill…）。
    v0.7 全部实测并把关键几条做成可执行判据，完整清单见 **§8**。接下一门非原生运行时
    （MSYS2 / WSL / 便携式 Ruby / 绿色版 JDK）之前先读那一节，别重新踩一遍。

## 6. 回切官方 Docker / Piston 的清单

前端**零返工**：只需把 `src/main.ts` 里注入的 Runner 从 `createLocalRunner(...)` 换成
`createPistonRunner({baseUrl, versions, token, enabled:true})`，线协议纯函数
（`src/runners/server/protocol.ts`）与 `RunRequest / RunResult` 原样复用。
`PISTON_LANGUAGES` 已经含 `php: 'php'`，官方 pkgs 有 `php 8.2.3`。运维侧则要满足：

1. Linux 主机 + Docker + Docker Compose，纯 cgroup v2（v1 必须关）；
   `docker run --privileged` 或 compose `privileged: true`。
2. `GET /api/v2/runtimes` 动态生成版本，不要抄 `PistonConfig.versions` 常量。
3. 显式设置 `PISTON_RUN_MEMORY_LIMIT` / `PISTON_COMPILE_MEMORY_LIMIT`（默认 **-1 无限制**）、
   `PISTON_OUTPUT_MAX_SIZE`（默认 1024，会静默截断结果）、按语言用
   `PISTON_LIMIT_OVERRIDES` 放宽 JVM/R 的 `run_timeout`（默认 3 秒）。
4. **Piston 自身无鉴权**：反代加 token / 只绑内网 / 防火墙三选一。
5. 公共 API 自 2026-02-15 起不再免费发放 key，且明确不给个人项目，只能自建。
6. A′ 的 `runtimes.local.json` 路径配置在回切后失效 —— 官方用 `ppman install
   <lang>=<version>` 把预编译包放进 `/piston/packages` volume，宿主机不用装解释器，
   但**动作本身没省**，compose 也不会自动装，且容器重建/无状态部署会清零。

## 7. 加下一门语言（Java / WSL…）

节点侧：**在 `builtinSpecs()` 加一条 spec**（§3.3），必要时在 `runtimes.json` 加一条
`{ "path": "" }`；本机装好解释器，或在 `runtimes.local.json` 指到便携式路径。
**先确认入口形态**：若 `path` 指向的是 `#!/bin/sh` / `#!/usr/bin/env ...` 这类脚本而不是
PE / ELF，必须配 `wrapEntry` + `envFromTool`（§3.3、§9），否则探测阶段就会静默失败。
前端按项目固定五步：登记 `LangId / LANG_DEFS / SAMPLES` → `LOCAL_LANGUAGES` 补映射
并把语言加进 `createLocalRunner().languages` → `createRegistry` 注入（`main.ts` 已统一注入）
→ CodeMirror 语法包动态 import → 端到端判据 + 单测层/真机层拆线负例。**UI 一行不改**。

授权口径：服务端自用一般不触发 GPL 的「分发」义务，但 R 本体是 `GPL-2|GPL-3`、
CRAN 里有 AGPL-3 包（对外服务会触发 §13）、OpenJDK 是 `GPLv2+CPE`、Oracle JDK 用
NFTC（免费窗口带日历）、PHP 8.5 及更早是 `PHP License 3.01`（有名称与署名条款，
新版已改 BSD-3-Clause）。**装包前先确认发行版与版本**，别把预编译 tar 直接对外分发。
Perl 是 Artistic / GPL 双许可，**Cygwin 运行时另有自己的许可条款**：本次只在本机自用、
不随项目分发，所以未逐条核验；若以后要把 Cygwin 运行时随节点打包发布，须单独做法务评估。

## 8. Cygwin Perl 实测报告与坑清单（v0.7 · 后续接非原生运行时前必读）

> 这一节是**实测记录**，不是设计推演。何工刻意选 Cygwin Perl（而非 ActivePerl /
> Strawberry Perl），目的就是验证「本项目调用 Cygwin 环境的运行时是否符合预期」。
> 结论：**跑通了，没有阻断性问题**；但踩到一组「非原生 Windows 运行时」特有的坑，
> 其中有几条如果不记下来，下次接 MSYS2 / WSL / 便携式 Ruby 会以另一种样子再出现。

### 8.1 环境与接法

| 项 | 值 |
|---|---|
| 解释器 | `D:/cygwin64/bin/perl.exe`（12,800 B stub），`cygperl5_32.dll` + `cygwin1.dll` 同目录 |
| 版本 / 风味 | `5.32.1` / `$^O = cygwin`（`perl -e 'printf "%s|%s\n", $^V, $^O;'`） |
| 是否 Windows 原生 | 否。Cygwin POSIX 运行时，**与本机 Git Bash 的 MSYS2 是两套** |
| 是否在 PATH | **否**（宿主 `PATH` 里没有 `cygwin64`，`$ENV{PATH}` 探测为 0） |
| 怎么挂进来 | `runtimes.local.json` 的 `perl.path` 绝对路径 ⇒ `source=config` |
| 节点侧改动 | `builtinSpecs()` 加一条 perl spec，**`execute()` 一个语言分支都没加** |

### 8.2 实测 15 项（手工 HTTP + 真机判据，全部通过）

| # | 场景 | 结果 |
|---|---|---|
| 1 | `GET /api/v2/runtimes` | `perl / 5.32.1 / source=config / flavor=cygwin`，`health.missing={}` |
| 2 | 纯 ASCII stdout | `PERL-ASCII-OK`，`code=0` |
| 3 | 中文（源码写进 `.pl` 文件） | UTF-8 字节原样回显 |
| 4 | 中文 `use utf8 + :encoding(UTF-8)` | 正确 |
| 5 | 中文 `binmode ':utf8'` **无** `use utf8` | **乱码**（见坑 ②） |
| 6 | stdin 注入 | `marker-42` 读回 |
| 7 | stderr + `exit 2` | 分离且退出码正确 |
| 8 | 多文件 `require 'helper.pl'` | 通过（依赖 `-I.`，见坑 ⑤） |
| 9 | `$^O` / `getcwd()` / `File::Spec` | `cygwin` / `/cygdrive/c/...` / `a/b` |
| 10 | CRLF | `A\nB\n` 保持 LF，**未**被转成 CRLF |
| 11 | backtick `` `echo ...` `` | 成功（宿主 PATH 无 cygwin，见坑 ④） |
| 12 | 相对路径写文件 | `-s 'written.txt' = 1`，落在节点每次新建的临时目录 |
| 13 | `IO::Socket::INET` 建 UDP socket | `SOCKET-OK`（如实登记无网络隔离，见坑 ⑨） |
| 14 | 墙钟超时 `sleep(30)` / 700ms | `status=TO`，只押状态不押毫秒 |
| 15 | 输出限额 / `../evil.pl` 路径逃逸 | `status=OL` 截断 / HTTP 400 拒绝 |

Windows 风格路径参数也单独验过：`C:\...\main.pl`、`C:/.../main.pl`、MSYS 映射
`/tmp/.../main.pl` **三种写法 Cygwin 都认**（Cygwin 运行时自动做路径转换），
所以节点传 `cmd.Dir` 的 Windows 路径 + 相对 `main.pl` 不需要额外适配。

### 8.3 坑清单（★ = 已做成可执行判据）

| # | 现象 | 根因 | 规避 / 判据 |
|---|---|---|---|
| ① ★ | **Git Bash 里 `perl -e 'print "中文";'` 静默无输出**：`exit=0`、stdout/stderr 都 0 字节，极易误判成「Cygwin 不支持中文」 | MSYS2（Git Bash）把中文 argv 按 cp936 转给非 MSYS 程序，Cygwin perl 收到的 `-e` 脚本被吃掉 | **测非原生运行时一律用「写文件 + HTTP JSON body」，不要用 shell 传中文 argv**。项目里代码走 `files[].content`，根本不经过 argv，所以中文正常；§8.2 #3 是正解 |
| ② ★ | `binmode(STDOUT, ':utf8')` 但没 `use utf8` ⇒ `ä¸\xadæ\x96\x87...` | 源码 UTF-8 字节被当 Latin-1 字符，`:utf8` 层再编码一次 | 正确写法 `use utf8; binmode(STDOUT, ':encoding(UTF-8)');`。判据 `perl/utf8-layer-trap` 押「两种写法结果不同」，不押具体乱码字节 |
| ③ ★ | `getcwd()` 是 `/cygdrive/c/...`、`File::Spec` 用 `/`、`$^O=cygwin` | Cygwin 把 Windows 路径映射成 POSIX 视图 | 代码里别硬编码 `\` 与 `C:` 做 `open`；**`/tmp` 是 Cygwin 的 `/tmp`，不是 Git Bash 的、也不是 Go `os.MkdirTemp` 那个目录**。判据 `perl/cygwin-semantics` 按 `flavor` 分叉，换原生 Perl 不误红 |
| ④ ★ | 宿主 `PATH` 里没有 `cygwin64`，但 `` `echo` `` / `system()` 照样能起 `/bin/sh` | Cygwin 运行时初始化时自补 `/usr/bin`；且 `cygwin1.dll` / `cygperl5_32.dll` 靠 **exe 同目录**被找到（Windows DLL 搜索顺序），不靠 PATH | 节点**不需要**为便携式 Perl 注入 PATH；但这是隐式环境，能跑哪些外部命令取决于 Cygwin 装了什么。⚠️ **推断未实测**：把 `perl.exe` 单独拷到别处、不带同目录两个 dll 必然起不来 ⇒ 配 `path` 时别只拷 exe |
| ⑤ ★ | 附加 `helper.pl` 后 `require 'helper.pl'` 失败（若不处理） | Perl 5.26+ 把 `.` 从 `@INC` 移除（安全改进） | spec 的 `run` 加 `-I .`，与 Go/PHP「附加文件同目录」语义对齐；`probes.includePath=-I.` 如实登记。判据 `perl/multi-file` |
| ⑥ | `\n` 没变 CRLF、stdin 注入也正常 | 当前 Cygwin `/cygdrive` 是 binary 挂载 | 判据 `perl/crlf` 验证。**风险提示**：这是当前挂载设置的事实，换机器或挂载成 text 模式可能变；`probes.encoding=utf8-only` 只承诺字节口径，不承诺换行 |
| ⑦ | `flavor` 若写死 `cygwin`，换 Strawberry / Linux perl 就撒谎 | 宿主风味是运行时属性，不是语言属性 | `detectArgs` 一次输出 `$^V\|$^O`，`flavorRe` 解析 ⇒ `runtimes[].flavor` + `probes.runtimeFlavor` 如实回报。判据 `perl/flavor` 让解释器再自报一次核对，**不押死具体值** |
| ⑧ | **推断未实测**：`fork()` / `system()` 子进程可能残留 | Windows `Process.Kill()` 只杀主进程；Cygwin 的 fork 是模拟实现 | `probes.processTreeKill=not-guaranteed-on-windows` 已声明；超时判据用 `sleep(30)` 且只押 `status=TO`，不押毫秒。真要长期跑不可信代码 ⇒ 回切官方 Docker + isolate |
| ⑨ ★ | socket 能建、`LWP` / `system()` 也能用 | A′ 本来就没有内核级网络隔离；Cygwin 有完整 socket 栈 | `probes.network=no-enforcement;IO::Socket-available`，**别对外宣称「零外联」**。CDP 抓包只覆盖浏览器 target，看不到节点进程 |
| ⑩ | **风险提示未实测**：本机同时有 MSYS2 与 Cygwin，两套 POSIX 运行时的 `/usr/bin`、`/tmp`、`fork` 语义不同 | 两套 `cygwin1.dll` 变体不能混用 | 本项目刻意用**绝对路径 + HTTP** 解耦，不在 shell 里把 MSYS 路径 / 管道链式喂给 Cygwin 程序；接 WSL / MSYS2 运行时时同样不要链式调用 |

### 8.4 对后续工作的可复用结论

1. **「手动配置运行时路径」不是可选项，是这类运行时的唯一接法**：`check:node` 的
   `fallback/perl-follows-path-truth` 反证了清空 `path` 后 perl 立刻从能力表消失。
   以后接便携式 Ruby / 绿色 JDK / WSL 里的解释器，都按同一套 `path` → `source=config`
   → `GET/POST 双探测` 走，`execute()` 不需要动。
2. **宿主风味要用探测值，不要写死**：`flavorRe` 是通用机制（`$^O` / `R.version.string` /
   `RUBY_PLATFORM` / `java -version` 都能套）。判据一律「让解释器自报一次，与节点回报核对」，
   这样换机器、换发行版都不误红。
3. **判据要押可观察副作用，不要押「我觉得应该没问题」**：§8.3 里带 ★ 的六条全部落在
   `selftest.ts` / `check-node.mjs`，拆线负例会证明它们真的连着接线层。
4. **测非原生运行时的三条纪律**：中文走文件不走 argv；路径用绝对路径且带齐 dll；
   每次都验 stdin / stdout / stderr / 退出码 / 编码层 / cwd / 换行 / 子进程 / socket 九项。
5. **越「完整」的运行时越要收紧对外的说法**：Cygwin Perl 能力比 WASM 版 Python 完整得多，
   但 A′ 没有笼子 ⇒ 仍是 `process-only` / `advisory`、结果不可判分。
   语言能力变强 ≠ 隔离档变高，这两件事不要混。

## 9. Cygwin R 实测报告与坑清单（v0.8 · 脚本型入口，接任何 shebang launcher 前必读）

> 这一节同样是**实测记录**，不是设计推演。何工这一门刻意指定 Cygwin R，并事先点明
> 「入口本质是 Bash 脚本，而不是可执行文件，会不会出意外仍是未知数」。结论：
> **确实出了意外，而且不止一个**：Windows 不能 exec 脚本、宿主环境让 Cygwin sh 静默失败、
> 宿主导出的 bash 函数污染了 R 的启动脚本。**跑通了，但必须靠通用包装 + 环境净化**，
> 不是把 `path` 指过去就能用。这三条都不会在纯函数单测里暴露。

### 9.1 环境与接法

| 项 | 实测值 |
|---|---|
| 入口 | `D:/cygwin64/bin/r`，**8953 B 文本脚本**，首行 `#!/bin/sh`；同目录 `R` 是同一个 wrapper，`Rscript.exe` 才是原生 PE |
| 版本 / 风味 | `R version 4.2.1 (2022-06-23) -- "Funny-Looking Kid"` / `Platform: x86_64-pc-cygwin` |
| 是否 Windows 原生 | 否。Windows 侧看它是**一个不能直接执行的文本文件**，Cygwin 侧才是一个 shell 入口 |
| 是否在 PATH | **否**（与 Cygwin Perl 一样），`GET /api/v2/runtimes` 里 `source=config` |
| 怎么挂进来 | `runtimes.local.json` 的 `r.path` 绝对路径 + spec 的 `wrapEntry: cygwinShellWrap` + `envFromTool: cygwinCleanEnv` |
| 节点侧改动 | `builtinSpecs()` 加一条 r spec + **两个通用钩子**（`launcher` / `execPlan.wrap` / `stageEnv` 前缀净化）；**`execute()` 一个语言分支都没加** |
| 启动形态 | 单阶段 `sh.exe <r> --vanilla --slave --file=main.R`，响应无 `compile` 字段 |
| probes 登记 | `stages=run` · `entryKind=shell-script;#!/bin/sh` · `wrapper=sh.exe <script>` · `flavorFrom=R --version / Platform` · `network=no-enforcement;serverSocket-available` · `startupWarning=host-specific;stats-namespace-may-be-unavailable` |

### 9.2 实测表（手工 HTTP + 节点判据 + 浏览器真机三层，全部通过）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 入口字节形态 | `#!/bin/sh` · 8953 B · 非 PE |
| 2 | **反证**：Python `subprocess.run([r, '--version'])` | `OSError [WinError 193] %1 不是有效的 Win32 应用程序` |
| 3 | **反证**：`sh.exe <r> --version` 直接继承宿主环境 | `rc=127`，stdout / stderr **都 0 字节**（静默失败，最容易误判成「R 没装好」） |
| 4 | `sh.exe <r> --version` + 干净 env | 86 ms 输出 `R version 4.2.1` / `Platform: x86_64-pc-cygwin` |
| 5 | `GET /api/v2/runtimes` | `r / 4.2.1 / source=config / flavor=cygwin`，`health.missing={}` |
| 6 | 纯 ASCII stdout | `cat(...)` 原样回显，`code=0` |
| 7 | 中文 UTF-8 往返 | `中文标记：昆明` 原样（代码写进 `.R` 文件，不经 argv） |
| 8 | stdin 注入 | `readLines("stdin", n=1)` 读回 `marker-42` |
| 9 | stderr + `quit(status=2)` | stderr 分离、`exitCode=2` |
| 10 | 多文件 `source("helper.R")` | `HELPER: HELPER-MARK` |
| 11 | `R.version$os` / `getwd()` | `cygwin` / `/cygdrive/c/...` |
| 12 | CRLF | `A\nB\n` 保持 LF，未转 CRLF |
| 13 | **宿主 `BASH_FUNC_*` 净化** | stderr 里 `safe-bin` / `pipefail` / `command not found` 全消失 |
| 14 | `requireNamespace("stats")` 自报 | `STATS= FALSE`，`During startup - Warning message: package 'stats' ... was not found` **保留不掩盖** |
| 15 | `serverSocket(0)` | `SOCKET-OK` ⇒ 如实登记「无内核级禁网」 |
| 16 | 语法错误 | `Error:` 进 stderr，退出码非零 |
| 17 | 墙钟超时 `Sys.sleep(30)` / 1500 ms | `status=TO`，只押状态不押毫秒（R 启动本身约 700 ms） |
| 18 | 输出字节限额 | `status=OL` 截断 |
| 19 | `../evil.R` 路径逃逸 | HTTP 400 拒绝 |
| 20 | **反证**：同目录无 `sh.exe` | r 不登记 · `health.missing` 写「脚本包装器不可用」· execute 400 |

`npm run check:node` **46 条**（含上表 5 / 13 / 14 / 20），`src/tests/r.test.ts` 8 条，
`selftest.ts` 里 `r/*` 18 条 + `sample/r` 1 条，dev / dist 双层各 138 条全绿。

### 9.3 坑清单（★ = 已做成可执行判据）

| # | 现象 | 根因 | 规避 / 判据 |
|---|---|---|---|
| ① ★★ | **直接 exec `D:\cygwin64\bin\r` 报 `WinError 193`** | 它是 `#!/bin/sh` 文本脚本，Windows `CreateProcess` 只认 PE | 通用 `wrapEntry`：用同目录 `sh.exe` 显式执行脚本。判据 `config/r-probes-script-wrapper` 押 `entryKind` / `wrapper`；别改用 `Rscript.exe` 绕过，那样测的就不是何工指定的入口 |
| ② ★★ | **版本表能报出 r，真执行却 127** | 探测路径和 `execute()` 是两条代码路径，包装器只加在后者就会出现「探测绿、执行红」 | `resolveRuntime()` 探测时**同样**调 `wrapEntry` 与 `n.stageEnv(spec, tool)`。这是「判据绿了只说明我押的那条路是通的」的又一实例 |
| ③ ★★ | `sh.exe <r> --version` 在宿主环境里 `rc=127` 且**空输出** | 宿主 Git Bash / MSYS2 的 PATH、路径自动转换变量把 Cygwin sh 带偏，失败还没诊断 | `envFromTool = cygwinCleanEnv()` 重建 `PATH=<cygwin bin>;C:\Windows\System32;C:\Windows`、`HOME=<cygwin root>/home`、`CYGWIN=nodosfilewarning`；`envStrip` 显式剥 `MSYSTEM` / `MSYS2_*` / `MSYS_NO_PATHCONV` / `BASH_ENV` / `ENV` / `SHELLOPTS` / `BASHOPTS` 等 |
| ④ ★★★ | **R stderr 混入宿主安全删除守卫的报错**：`safe-bin/rm: line 4: $'\r': command not found`、`set: pipefail: invalid option name` | 宿主把 `rm` / `rmdir` / `unlink` 以 **`BASH_FUNC_RM%%=() { "${CODEBUDDY_SAFE_DELETE_BIN_DIR}/rm" "$@" }`** 形式导出；Cygwin sh 启动会 import 这些函数覆盖 `rm`，R 启动脚本调用 `rm` 时命中 MSYS2 版 CRLF 脚本。**只剥 `BASH_ENV` 仍复现** | `stageEnv()` 一律剥掉 `BASH_FUNC_` 前缀变量；变量名用 `strings.ToUpper()` 归一化（Windows 的 `Path/PATH/path` 大小写不敏感，按字面剥会漏）。判据 `r/clean-host-env` 押 stderr 不含 `safe-bin|pipefail|command not found`；`check:node` 的 A 场景也从节点侧押一遍 |
| ⑤ ★★ | R 每次启动都告警 `package 'stats' in options("defaultPackages") was not found`，`sd()` / `lm()` 不可用 | `stats.dll` 在，但 `cygcheck` 报缺 **`cyglapack-0.dll`** —— 是**本机 Cygwin R 安装不完整**，不是节点净化造成 | 设 `R_DEFAULT_PACKAGES=base` 能消掉告警，但 `requireNamespace("stats")` 仍 FALSE ⇒ **那是把缺陷藏起来，不做**。`probes.startupWarning` 如实登记；判据 `r/default-packages-truth` 押「自报 + 不可用时必须有告警」，换机器修好也不误红 |
| ⑥ ★ | 硬编码 `flavor=cygwin`，换 Linux / 原生 Windows R 就撒谎 | 风味是运行时属性 | `--version` 的 `Platform:` 行走通用 `flavorRe` 解析；判据 `r/flavor` 让 R 自报 `R.version$os` 与节点回报核对，`r/version` 押 `getRversion()` 与动态探测版本一致 |
| ⑦ | 宿主 `R_PROFILE` / `R_LIBS` / `.RData` 等状态可能漏进临时执行 | `--vanilla` 能挡一部分，但不能只靠它 | `--vanilla --slave --file=` 三件套 + `envStrip` 显式剥 `R_HOME / R_LIBS / R_LIBS_USER / R_PROFILE* / R_ENVIRON* / R_DEFAULT_PACKAGES`。**注意反向**：剥 `R_DEFAULT_PACKAGES` 正是为了不掩盖 ⑤ |
| ⑧ ★ | `getcwd()` = `/cygdrive/c/...`、`R.version$os=cygwin`、分隔符 `/` | Cygwin POSIX 视图，与 MSYS2 是两套 | 判据 `r/cygwin-semantics` 按 `flavor` 分叉（`cygwin` 押 `/cygdrive/` 前缀，其它风味只押 `getwd()` 非空）；`perl/cygwin-semantics` 同构。**推断未实测**：Cygwin `fork()` 子进程在 Windows `Process.Kill()` 后可能残留，超时判据只押 `status=TO` |
| ⑨ ★ | `serverSocket(0)` 能监听 | A′ 无内核级网络隔离，Cygwin 有完整 socket 栈 | `probes.network=no-enforcement;serverSocket-available`，**别对外说零外联**；CDP 抓包只覆盖浏览器 target，看不到节点进程（§3.4 已记） |
| ⑩ ★ | 只 `os.Stat` 到入口就说「r 可用」 | 脚本入口能存在 ≠ 能启动，缺包装器时连 `--version` 都跑不了 | `wrapper/r-not-registered-without-sh` / `health-explains-missing-shell` / `execute-rejected` 三条反证：把入口拷到无 `sh.exe` 的目录必须**置灰 + 给原因 + 400**，不许谎报可用 |

### 9.4 对后续工作的可复用结论

1. **入口形态要当成一等配置**：`path` 指向的文件是 PE / ELF / shebang 脚本，决定了
   `wrapEntry` 与 `envFromTool` 要不要挂。以后接 WSL 里的解释器、绿色版 JDK 的 `.cmd`
   launcher、Python venv 的 `bin/foo` 包装脚本，先 `file` / 看首行，再写 spec。
2. **「探测」与「执行」必须共用同一套启动计划**，包括包装器和环境变量。任何只在其中
   一边生效的适配，都会产出「能力表说能用、点运行就 127」这种最难查的假绿。
3. **宿主环境是隐藏的输入**：`BASH_FUNC_*` / `BASH_ENV` / MSYS2 PATH 不是「用户环境」，
   而是会改变被测程序行为的注入源。对非原生运行时，默认应当**白名单重建环境**，
   而不是「继承后剥几个黑名单」——本轮是从黑名单起步才踩到 ④。
4. **能力缺口不许用开关盖掉**：`stats` 缺 DLL 是宿主事实，`R_DEFAULT_PACKAGES=base`
   会让 stderr 变干净，但 `sd()` 仍不可用 ⇒ 判据必须押「解释器自报 + 缺口时告警」。
   这条与「能力表不谎报」「不拿 0 冒充 memoryBytes」是同一条纪律。
5. **通用钩子没有破坏三处防返工接缝**：`createRegistry(getMount, serverRunners)` 仍是
   注入实例，`trusted` 仍由 Runner 的 `trust` 推导，后端专有语言名仍在
   `PISTON_LANGUAGES` / `LOCAL_LANGUAGES`。换官方 Docker + Piston 时，这些脚本包装细节
   全部留在 A′ 节点侧，前端一行不用改。
6. **连续跑真机负例时，正向判据会被本机负载误伤 —— 别为此弱化判据**：v0.8 真机判据
   从 119 涨到 138 条，九组真机负例串行跑约 14 分钟；第 2 / 3 组（拆 Lua / SQL 的 stdout
   通道）各自多红了一条 `sample/go` 与 `go/multi-file`，FAIL 明细都是
   `program.exe 阶段超过 3000ms 被终止`。**这不是判据漂移**：本机 CPU 负载下 Go run 阶段
   的 3 秒墙钟偶发超时，与 Lua / SQL 被改坏的对象毫无关系；单独复跑两组都精确通过
   （8 条 / 7 条），前后两次正式 dev / dist 自检也各是 138 条全绿。
   ⇒ 遇到「红得比预期多一条」先看 FAIL 明细是不是 `TO` / `status=timeout`；
   **不要**把 `EXPECTED_RED` 放宽成「允许偶发红」，也不要为了跑绿去抬高
   `DEFAULT_LIMITS.wallMs` —— 前者掩盖抖动，后者把用户代码预算和宿主机开销混为一谈。
   这与「超时判据只押 `status=TO`、不押毫秒数」是同一条口径的两面。


## 10. Ruby 4.0.9 实测报告（v0.9 · 原生 PE / 纯 PATH 探测，接下一门原生运行时前先读）

何工这一门的定位是「本机 Windows 已安装最新版本 Ruby，PATH 下应当能发现解释器」。
**「应当」要实测**：本机确实是 RubyInstaller2 的 UCRT 版原生 PE，第一次出现
「既不是 WASM、也不在 PATH 之外、也不是 shebang 脚本」的运行时，正好用来反证
§8 / §9 的通用钩子不是给 Cygwin 特设的后门。

### 10.1 环境与接法

| 项 | 实测值 |
|---|---|
| 安装 | RubyInstaller2 `C:\Ruby40-x64\bin\ruby.exe`，PATH 里 `/c/Ruby40-x64/bin/ruby` |
| 版本自报 | `ruby 4.0.9 (2026-10-23 revision 3e93b23afc) +PRISM [x64-mingw-ucrt]` |
| `RUBY_PLATFORM` / `Encoding.default_external` | `x64-mingw-ucrt` / `UTF-8` |
| 入口形态 | 33792 B，头两字节 `MZ` ⇒ **原生 PE**；同目录没有 `sh.exe`（`rubyw.exe` 存在） |
| 配置 | `runtimes.json` 里 `"ruby": { "path": "", "disabled": false }`，**留空走 `exec.LookPath("ruby")`** |
| 探测 | `ruby --version` 一次拿版本与风味；`flavorRe` 从 `[x64-mingw-ucrt]` 解析出 `mingw` |
| 执行 | `ruby -I . main.rb`（单阶段，响应不带 `compile` 字段） |
| 环境 | **保留 PATH**；剥 `RUBYOPT / RUBYLIB / RUBYPATH / GEM_HOME / GEM_PATH / GEMRC / BUNDLE_*` |
| 判据 | 节点新增 16 条（`node/*` 2 + `config/ruby-*` 12 + `disabled/*` 1 + `fallback/*` 1）+ 真机 18 条 `ruby/*` + `sample/ruby` |

### 10.2 实测表（Python 子进程 → 节点 HTTP → 浏览器真机，三层全部通过）

| # | 项 | 结果 |
|---|---|---|
| 1 | `where ruby` / `command -v ruby` | `C:\Ruby40-x64\bin\ruby.exe` / `/c/Ruby40-x64/bin/ruby` |
| 2 | 直接 exec `--version` | rc=0，一行出版本与 platform（**无需包装器**） |
| 3 | `GET /api/v2/runtimes` | `ruby 4.0.9` / `aliases=[rb,ruby4]` / `source=path` / `flavor=mingw` |
| 4 | `POST /api/v2/execute` | 200，`run.stdout` 有字节、`code=0`、无 `compile` 字段 |
| 5 | 中文源码 + 中文 stdin（写文件 + bytes） | `puts "中文标记：昆明"` 与 `STDIN.gets` 都按 UTF-8 往返 |
| 6 | `$stdout.external_encoding` | 空；`Encoding.default_external=UTF-8`，`__ENCODING__=UTF-8` |
| 7 | `STDOUT.write("A\nB\n")` → 文件 stdout | `A\r\nB\r\n`；**管道 stdout 同样 CRLF** |
| 8 | `require 'json'` / `'openssl'` | 均成功（`{"a":1}` / `4.0.2`），标准库可用 |
| 9 | `require 'helper'`（同目录附加文件） | **LoadError**；`require_relative 'helper'` 与 `ruby -I .` 都成功 |
| 10 | `TCPServer.new('127.0.0.1', 0)` | 可监听，`probes.network=no-enforcement;TCPServer-available` |
| 11 | 语法错误 `def x(` | rc=1，PRISM 详细诊断进 stderr，stdout 空 |
| 12 | 宿主注入 `RUBYOPT=-rjson` / `RUBYLIB=<tmp>` | 节点剥掉后 Ruby 自报 `RUBYOPT=nil` 与 `RUBYLIB=nil` |
| 13 | `disabled: true` 且 PATH 有 ruby | 不登记，`health.missing.ruby` 明写 disabled |
| 14 | 空 path 回退 | `source=path` 且版本与 `--version` 一致 |

### 10.3 坑清单（★ = 已做成可执行判据）

1. ★ **入口形态是配置，不是常识**：R 是 shebang 脚本要 `sh.exe` 包装，Ruby 是 PE 直接 exec；
   同一张 `builtinSpecs()` 表用 `wrapEntry` 的「有 / 无」表达，别给原生语言硬套包装器，
   也别假设「装了就能 exec」。`node/ruby-entry-is-native` 读文件头，
   `config/ruby-probes-native-entry` 押 `entryKind=native-executable;no-wrapper`。
2. ★ **Windows 原生 Ruby 输出 CRLF**：`puts` 与 `STDOUT.write` 都把 `\n` 转成 `\r\n`
   （管道与文件 stdout 均如此），与 Cygwin Perl / R 的 LF 相反。节点**不归一化**：
   同一份字节若被改写，用户显式写出的 `\r\n` 会被毁掉。
   `probes.lineEndings=no-normalization;platform-native`，真机 `ruby/crlf` 按解释器自报的
   flavor 押「该有的换行」，换 Linux 不误红 —— **判据别押死 CRLF**。
3. ★ **`-I .` 不是可选优化**：Ruby 1.9+ 把 `.` 移出 `$LOAD_PATH`，`require 'helper'` 会
   LoadError；不加就与 Go / PHP / Perl 的「附加文件同目录」语义不一致。
   `require_relative` 本来就可用，两条都做成判据（`ruby/multi-file` / `ruby/require-relative`）。
4. ★ **宿主 Ruby 变量是隐藏输入**：`RUBYOPT`（启动期 `-r` 自动加载）、`RUBYLIB` / `GEM_*` /
   `BUNDLE_*` 会把本机 gem 与自动加载带进执行环境。对照 §9 的 `BASH_FUNC_*` 教训，
   **原生运行时不能重建 PATH**（Ruby 靠它找 DLL 与子进程）⇒ 只剥 Ruby 专属变量。
   判据必须**故意注入**才有意义：`check:node` 的 A 场景用
   `startNode(config, { RUBYOPT: '-rjson', RUBYLIB: tmpdir() })`，再让 Ruby 自报 `ENV`。
5. ★ **PATH 发现也要有反证**：`source=path` 不能只靠一次绿灯，`disabled:true` 必须压过
   PATH 探测（坑 108「关必须是第一句」），空 path 回退也必须照实报。
   `disabled/ruby-hidden-despite-path` / `fallback/ruby-follows-path-truth`。
6. **第三方 gem 不承诺**：本机标准库 json / openssl 可用，但 gem 集随机器安装变化，
   A′ 无可复现性。默认示例刻意只用标准库，`sample/ruby` 判据直接跑 `SAMPLES` 原文；
   别在示例里 `require` 任何第三方 gem。

### 10.4 对后续工作的可复用结论

1. **「入口形态」当一等配置**：PE / ELF / shebang / `.cmd` / `.bat` 是五种不同的东西。
   探测与执行必须共用同一份启动计划（§9.4 结论 2 在这里再次成立：Ruby 没有 wrap，
   但 env 仍与探测共用 `stageEnv`）。
2. **净化策略按运行时分档**：非原生 POSIX（Cygwin / MSYS2）白名单重建环境；
   原生 Windows 运行时保留 PATH、只剥语言专属变量。别把任一档的做法无差别套到另一档。
3. **平台差异如实登记，别用开关抹平**：CRLF / LF、`$LOAD_PATH`、默认包可用性都是宿主事实；
   节点负责「不改写字节 + 登记 `probes`」，判据负责「按解释器自报押真值」，UI 不做归一化。
4. **负载抖动随判据数变多**：v0.9 真机判据 157 条，十组真机负例串行十四分钟里
   第 1 组（拆 iframe）与第 10 组（拆 Ruby）各多红一条 `go/output-limit`，
   FAIL 明细都是 `status=timeout`；单独复跑分别精确通过 12 / 20 条。
   处置同 §9.4 第 6 条：**不放宽 `EXPECTED_RED`、不抬 `DEFAULT_LIMITS.wallMs`**。
5. **三处防返工接缝一处没动**：`createRegistry(getMount, serverRunners)` 注入实例、
   `trust` 由 Runner 自报、后端专有语言名在 `PISTON_LANGUAGES` / `LOCAL_LANGUAGES`。
   Ruby 只是 `builtinSpecs()` 里多一条 spec + 前端固定五步，回切官方 Docker + Piston
   时前端一行不改。
