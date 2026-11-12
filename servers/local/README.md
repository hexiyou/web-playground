# A′ 本地执行节点 · 真值手册

> 本文件 + 仓库根 `playground-architecture-analysis.html` 第十三章 + `src/core/contract.ts`
> 是本节点的三份真值。**动手改之前先读「决策分叉」一节。**

## 1. 这是什么 / 为什么与官方推荐分叉

官方 Piston 推荐的部署是 `docker run --privileged`（或 compose 里 `privileged: true`），
要求**纯 cgroup v2 + v1 关闭**，原理是 `Isolate inside Docker`（Linux namespaces / chroot /
多个非特权 uid / cgroup）。`api/src/docker-entrypoint.sh` 会直接写
`/sys/fs/cgroup/isolate/cgroup.procs` 与 `cgroup.subtree_control`，这正是它必须跑在特权
容器里的原因，也是它**不能 Windows 原生跑、不能脱离 Docker 官方支持**的原因。

本项目 v0.5 刻意选了另一条路：**A′ 本机进程执行节点**，Go 单二进制、非 Docker、
跨平台、只绑回环地址。分叉依据是**威胁模型不同**，不是偷懒：

| | 官方 Piston | 本项目 A′ |
|---|---|---|
| 面向 | 任意陌生人的恶意代码 | 团队内几个人、自己写的可信片段 |
| 隔离 | isolate（内核级）+ Docker privileged | 进程级：墙钟 + 输出字节 + 并发 + 临时目录 |
| 结果可信度 | `graded`，可判分 | **`advisory`，不可判分** |
| 部署 | Linux + Docker + cgroup v2 + root | Windows / Linux / macOS，单二进制，零特权 |
| 网络 | 默认禁 socket | 编译期 `GOPROXY=off`，运行期不禁网络 |

**因此 A′ 的硬边界（改任何一条前先重新评估威胁模型）**：

1. **只绑 `127.0.0.1`**。`-addr` 传非回环地址会直接拒绝启动。需要跨机访问 ≠ 加个
   `0.0.0.0` 就完事，那等于把「能执行任意 Go 代码」的接口开放出去。
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
npm run smoke                      # 自动拉起/复用/关闭节点，跑真机自检
```

- 二进制落在 `servers/local/bin/playground-local(.exe)`，**不入库**（`.gitignore` 已排）。
- `scripts/local-server.mjs` 会先探活 `/health`：若 2000 端口已有节点在线则**复用**，
  结束时不会误杀何工手动开着的进程。
- 参数：`-addr`（默认 `127.0.0.1:2000`）、`-token`（空串关闭鉴权，不推荐）、
  `-max-parallel`（默认 4）。环境变量：`PLAYGROUND_SERVER_PORT`、
  `PLAYGROUND_SERVER_TOKEN`。
- 前端默认 `?server=<url>&token=<token>` 可覆盖（见 `src/main.ts`）。
- 需要本机有 `go`；`/api/v2/runtimes` 的版本由 `go version` 动态探测，不硬编码。

## 3. HTTP 接口（Piston v2 兼容子集）

| 端点 | 说明 |
|---|---|
| `GET /health` | 探活，回报 engine / goVersion / isolation / trust |
| `GET /api/v2/runtimes` | `[{language:"go",version:"1.27.0",aliases:["golang"]}]` |
| `POST /api/v2/execute` | 请求/响应同 Piston v2 形状 |
| `OPTIONS *` | CORS 预检，204 |

请求体接受的字段：`language / version / files[] / stdin / args / compile_timeout /
run_timeout / compile_cpu_time / run_cpu_time / compile_memory_limit /
run_memory_limit`，另加 A′ 扩展字段 **`output_max_size`**（官方 Piston 由环境变量配置，
不传则忽略）。`files[].name` 按 Piston 契约只接受纯 `.go` 文件名，任何路径（`../`、
绝对路径、分隔符）一律 400；`encoding` 只支持 `utf8`。

响应体：`{language, version, run:{...}, compile?:{...}, probes:{...}}`。
`compile` 是 `go build` 阶段，`run` 是生成的 exe 阶段；编译失败时 `compile.status = "RE"`，
`run` 是空壳并带 `message`，由 `compile.status` 决定总体状态，**不谎报执行过**。

**与官方 Piston 的差异（如实登记，不要当 bug 修）**：

- 六码 `status` 只产出 `RE / TO / OL / XX` 的子集；`SG`、`EL` 未实现。
- `cpu_time`、`memory` **不填**：Go 标准库跨平台拿不到子进程 CPU / 峰值内存，
  `probes` 里明写 `cpuTime=unavailable`、`memoryCapability=no-memory-cap`。
- `compile_cpu_time / run_cpu_time / *_memory_limit` 接收但**不执行**，
  只有墙钟、输出字节、并发上限是真闸（`probes.enforcedLimits` / `unsupportedLimits`）。
  `buildExecuteBody()` 仍然显式传这些字段，是为了将来切官方 Piston 时行为一致，
  不是假装现在就有。
- 只有 `go` 语言；`probes.stages = build+run`、`encoding = utf8-only`。

## 4. 已知坑（都踩过，别再踩回去）

1. **★★ Windows 管道 EOF**：`exec.Cmd` 用 `io.Writer` 做 stdio 时会建管道并起
   `io.Copy` goroutine，`go build` 的 compile/link 子进程继承句柄后，父进程退出
   `Wait()` 仍可能等 EOF。现在改用**真实 `*os.File`**，输出限额由「文件大小看门狗
   （超过 2×上限就 Kill）+ 读回截断」两层保证。`WaitDelay=250ms` 只作兜底。
2. **★★ 满 CPU 死循环在本机有环境开销**：实测 `for{}` 让 `go build` 慢约 6.3 秒、
   `TerminateProcess` 再慢约 5.4 秒；换成 `time.Sleep` 后分别是 1.5 秒 / 1.2 秒。
   这与管道无关，是本机 Windows 环境（安全软件/Defender 扫描新 exe）。
   ⇒ **超时判据只押 `status=TO` / `signal=SIGKILL`，不押 `wall_time` 毫秒数**；
   自检里用 `time.Sleep(30s)` 而不是 `for{}`。
3. **★ 服务端 Runner 不能直接返回 outputs**：`execute.ts` 是唯一入口，会用
   `collector.snapshot()` 覆盖 runner 返回的 `outputs`。v0.1~v0.4 服务端骨架从未真机
   接线，纯函数单测全绿却没人发现输出会被丢掉。现在由
   `emitServerResult()` 把纯函数的 outputs 逐条 `ctx.emit()`，输出字节限额仍归
   `collector` 统一收口；`local.test.ts` 有专门的**连线层判据**押这件事。
4. **`go.mod` 的 `go` 指令按探测版本动态取前两段**（`1.27.0` → `go 1.27`），
   写死会要求下载新工具链。同时强制 `GOTOOLCHAIN=local`、`GOPROXY=off`、
   `GOSUMDB=off`、`GOWORK=off`、`CGO_ENABLED=0`，编译期零外联、不需要 gcc。
5. **进程树 kill 不保证**：Windows 上 `Process.Kill()` 只杀主进程，用户代码 fork 的
   子进程可能残留（`probes.processTreeKill=not-guaranteed-on-windows`）。
   这也是「只跑可信代码」的又一条理由。
6. 每次执行新建独立临时目录并 `defer os.RemoveAll`，`go build` 无缓存复用，
   本机约 1.5 秒/次；真机自检窗口已从 90 秒放宽到 150 秒。

## 5. 回切官方 Docker / Piston 的清单

前端**零返工**：只需把 `src/main.ts` 里注入的 Runner 从 `createLocalRunner(...)` 换成
`createPistonRunner({baseUrl, versions, token, enabled:true})`，线协议纯函数
（`src/runners/server/protocol.ts`）与 `RunRequest / RunResult` 原样复用。
运维侧则要满足：

1. Linux 主机 + Docker + Docker Compose，纯 cgroup v2（v1 必须关）；
   `docker run --privileged` 或 compose `privileged: true`。
2. `GET /api/v2/runtimes` 动态生成版本，不要抄 `PistonConfig.versions` 常量。
3. 显式设置 `PISTON_RUN_MEMORY_LIMIT` / `PISTON_COMPILE_MEMORY_LIMIT`（默认 **-1 无限制**）、
   `PISTON_OUTPUT_MAX_SIZE`（默认 1024，会静默截断结果）、按语言用
   `PISTON_LIMIT_OVERRIDES` 放宽 JVM/R 的 `run_timeout`（默认 3 秒）。
4. **Piston 自身无鉴权**：反代加 token / 只绑内网 / 防火墙三选一。
5. 公共 API 自 2026-02-15 起不再免费发放 key，且明确不给个人项目，只能自建。

## 6. 加下一门语言（Ruby / PHP / R / Java…）

按项目固定五步：登记 `LangId / LANG_DEFS / SAMPLES` → 在 `LOCAL_LANGUAGES` 补映射并
在节点里加该语言的两阶段执行分支 → `createRegistry` 注入（已由 main.ts 统一注入）
→ CodeMirror 语法包动态 import → 端到端判据 + 拆线负例。**UI 一行不改**。

授权口径：服务端自用一般不触发 GPL 的「分发」义务，但 R 本体是 `GPL-2|GPL-3`、
CRAN 里有 AGPL-3 包（对外服务会触发 §13）、OpenJDK 是 `GPLv2+CPE`、Oracle JDK 用
NFTC（免费窗口带日历）、PHP 8.5 及更早是 `PHP License 3.01`（有名称与署名条款，
新版已改 BSD-3-Clause）。**装包前先确认发行版与版本**，别把预编译 tar 直接对外分发。
