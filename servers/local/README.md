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
prepare / compile / run`。`flavorRe` 可选，用来从探测输出里解析宿主风味（不硬编码）。
`compile` 为 `nil` 就是单阶段语言（PHP / Perl），非 nil 走编译 + 运行两阶段（Go）。
文件名白名单、环境净化、`go.mod` 生成、启动参数都由 spec 描述，`execute()` 里没有
任何 `if language == ...` 分支。前端仍按固定五步（登记 → Runner 映射 → 注入 →
CodeMirror → 判据负例），**UI 一行不改**。

### 3.4 判据

`npm run check:node` 在独立端口（默认 2099，可 `PLAYGROUND_NODE_CHECK_PORT` 改）重启节点
四次，只押 HTTP 接口能看到的事实：

| 场景 | 押什么 |
|---|---|
| A 配了 `php.path` / `perl.path` | `source === "config"` · `health.config` 指向临时文件且 `missing={}` · PHP/Perl execute 真吐出字节 · `perl.flavor === $^O` 且版本一致 · 中文 UTF-8、Cygwin cwd/分隔符、LF 不转 CRLF · Go 两阶段不回归 |
| B path 指向不存在 | php 与 perl 都从 runtimes 消失 · `health.missing` 说明原因 · 两门 `POST execute` 都明确 400 `runtime is unknown` |
| C `disabled: true` | PATH 里明明有 php、配置里明明有 perl，仍不登记（证明「关」优先于探测） |
| D `path: ""` | php 回退 PATH `source="path"` 且 execute 真跑通；**perl 按 PATH 里到底有没有它如实判**（本机没有 ⇒ 不登记，反证 A 场景全靠配置路径） |

v0.7 共 **26 条**。D 场景那条是「手动配置运行时路径」的价值证据：Cygwin Perl 不在 PATH，
清空 `path` 后能力表必须立刻置灰，不许拿缓存里的旧路径假装还能跑。

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
扩展名按语言白名单：Go 只收 `.go`、PHP 只收 `.php`、Perl 只收 `.pl`；`encoding` 只支持 `utf8`。
第一个文件是主文件；`name` 为空时按语言补 `main.go` / `main.php` / `main.pl`。

响应体：`{language, version, run:{...}, compile?:{...}, probes:{...}}`。
**单阶段语言（PHP / Perl）不带 `compile` 字段**，前端 `mapExecuteResponse()` 走编译缺省分支；
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
  配了才写）、Perl 的 `flavorFrom=$^O` / `includePath=-I.`、`encoding=utf8-only`。

**各语言的零外联口径（别混）**：

| 语言 | 做法 | 仍然能联网的路径 |
|---|---|---|
| Go | `GOPROXY=off / GOTOOLCHAIN=local / GOSUMDB=off / GOWORK=off` 只管编译期拉包 | 用户代码里的 `net/http` 可直连 |
| PHP | `-d allow_url_fopen=0 -d allow_url_include=0` 关 URL 包装器；`php.ini` 用宿主机默认 | `curl` / `sockets` / `stream_socket_client` 扩展仍可直连 |
| Perl | **没有任何禁网措施**：只剥掉宿主的 `PERL5LIB` / `PERL5OPT` / `PERLLIB` / `PERL_LOCAL_LIB_ROOT` / `PERL_MM_OPT`，避免把本机模块带进执行环境 | `IO::Socket::INET` / `LWP` / `system()` / `fork()` 全可用；Cygwin 有完整 socket 栈，`probes.network=no-enforcement;IO::Socket-available` |

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

## 7. 加下一门语言（Ruby / R / Java…）

节点侧：**在 `builtinSpecs()` 加一条 spec**（§3.3），必要时在 `runtimes.json` 加一条
`{ "path": "" }`；本机装好解释器，或在 `runtimes.local.json` 指到便携式路径。
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
