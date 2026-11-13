# A′ 本地执行节点 · 真值手册

> 本文件 + 仓库根 `playground-architecture-analysis.html` 第十三章 + `src/core/contract.ts`
> 是本节点的三份真值。**动手改之前先读「决策分叉」一节。**
>
> v0.6 变更：节点从「写死只跑 Go」改成**内建 runtimeSpec 表 + 每次真探测 + 可配置运行时路径**，
> 并接入第二门服务端语言 **PHP**。加下一门语言不再改 `execute()` 分支。

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
    "go":  { "path": "", "disabled": false },
    "php": { "path": "D:/portable/php-8.3/php.exe", "disabled": false }
  }
}
```

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
```

探测失败的语言**不出现在数组里**，前端 `RuntimeCache` 拿到版本表后，缺哪门就把哪门
判为 `unavailable` 并给出「安装到 PATH 或配 `runtimes.local.json`」的指引；能力表由注册表
推导，注册表声明的语言仍在，但真跑时如实报不可用 —— **绝不静默降级到 browser**。
探测失败的原因只写进 `GET /health` 的 `missing` 字段，不污染 Piston v2 线协议。

`POST /api/v2/execute` 也会重探测一次再跑：便携式 U 盘被拔走后，不会拿旧路径去执行。

### 3.3 加一门语言的节点侧改动

`builtinSpecs()` 里加一条 `runtimeSpec`：`language / aliases / execName / detectArgs /
versionRe / extensions / entryName / envStrip / envSet / probeExtra / prepare / compile / run`。
`compile` 为 `nil` 就是单阶段语言（PHP），非 nil 走编译 + 运行两阶段（Go）。
文件名白名单、环境净化、`go.mod` 生成、启动参数都由 spec 描述，`execute()` 里没有
任何 `if language == ...` 分支。前端仍按固定五步（登记 → Runner 映射 → 注入 →
CodeMirror → 判据负例），**UI 一行不改**。

### 3.4 判据

`npm run check:node` 在独立端口（默认 2099，可 `PLAYGROUND_NODE_CHECK_PORT` 改）重启节点
四次，只押 HTTP 接口能看到的事实：

| 场景 | 押什么 |
|---|---|
| A 配了 `php.path` | `runtimes.php.source === "config"` · `health.config` 指向临时文件 · PHP execute 真吐出字节 · `probes.runtimePathSource === "config"` · Go 两阶段不回归 |
| B path 指向不存在 | php 从 runtimes 消失 · `health.missing.php` 说明原因 · `POST execute php` 明确 400 `runtime is unknown` |
| C `disabled: true` | PATH 里明明有 php，仍不登记（证明「关」优先于探测） |
| D `path: ""` | 回退 PATH，`source === "path"`，execute 真跑通 |

报告落在 `.node-check-report.json`（不入库）。**真机自检（浏览器 CDP）只证明前端资产零外联，
证明不了节点进程的网络行为**，配置路径是否生效只能靠这一层判据。

## 4. HTTP 接口（Piston v2 兼容子集）

| 端点 | 说明 |
|---|---|
| `GET /health` | 探活，回报 engine / isolation / trust / `config` / `runtimes` / `missing` |
| `GET /api/v2/runtimes` | `[{language,version,aliases,source}]`，**只含这一刻能跑的语言** |
| `POST /api/v2/execute` | 请求/响应同 Piston v2 形状 |
| `OPTIONS *` | CORS 预检，204 |

`runtimes[].source` 是 A′ 扩展字段（`config` / `path`）；官方 Piston 没有，前端忽略即可。

请求体接受的字段：`language / version / files[] / stdin / args / compile_timeout /
run_timeout / compile_cpu_time / run_cpu_time / compile_memory_limit /
run_memory_limit`，另加 A′ 扩展字段 **`output_max_size`**（官方 Piston 由环境变量配置，
不传则忽略）。`files[].name` 按 Piston 契约只接受**纯文件名**（无路径、无分隔符），
扩展名按语言白名单：Go 只收 `.go`、PHP 只收 `.php`；`encoding` 只支持 `utf8`。
第一个文件是主文件；`name` 为空时按语言补 `main.go` / `main.php`。

响应体：`{language, version, run:{...}, compile?:{...}, probes:{...}}`。
**单阶段语言（PHP）不带 `compile` 字段**，前端 `mapExecuteResponse()` 走编译缺省分支；
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
  `runtimePathSource=config|path`、`runtimeVersion`、`encoding=utf8-only`。

**各语言的零外联口径（别混）**：

| 语言 | 做法 | 仍然能联网的路径 |
|---|---|---|
| Go | `GOPROXY=off / GOTOOLCHAIN=local / GOSUMDB=off / GOWORK=off` 只管编译期拉包 | 用户代码里的 `net/http` 可直连 |
| PHP | `-d allow_url_fopen=0 -d allow_url_include=0` 关 URL 包装器；`php.ini` 用宿主机默认 | `curl` / `sockets` / `stream_socket_client` 扩展仍可直连 |

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
