// Command playground-local 是 A′ 本机进程执行节点：Piston v2 兼容子集、非 Docker、
// 跨平台单二进制。它只服务「团队内几个人的可信代码片段」，不做内核级隔离。
//
// 决策分叉与回切条件见项目根 playground-architecture-analysis.html 第十三章。
// 真值手册见同目录 README.md。
//
// 硬边界（改之前先读文档）：
//  1. 只绑回环地址，非 loopback 直接拒绝启动；
//  2. 默认固定 token，只防本机其它页面误调，不是安全边界；
//  3. 每次执行独立临时目录，defer 清理；文件名按 Piston 契约拒绝一切路径；
//  4. 进程级墙钟 + 输出字节 + 并发上限，没有 CPU/内存/进程数内核限额；
//  5. ★ 语言运行时归宿主机：GET /api/v2/runtimes 每次真探测「这一刻能不能跑」，
//     探测不到就不登记（前端能力表自动置灰），不硬编码任何版本号。
//  6. ★ 运行时可执行文件可由 runtimes.local.json / runtimes.json 按语言指定绝对路径，
//     用来挂不在 PATH、没写注册表的便携式环境；path 留空则回退 PATH 查找。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const defaultToken = "pg-local-dev-token"

// ---------------------------------------------------------------- 配置

/** 每门语言可覆盖：path 指定可执行文件（绝对/相对节点 cwd），disabled 显式关闭。 */
type runtimeOverride struct {
	Path     string `json:"path"`
	Disabled bool   `json:"disabled"`
}

type runtimeConfig struct {
	Runtimes map[string]runtimeOverride `json:"runtimes"`
}

/**
 * 默认按 runtimes.local.json（本机覆盖、不入库）→ runtimes.json（入库模板）查找。
 * -config 显式指定时文件必须存在，否则判为配置错误而不是静默回退 —— 判据要抓得到。
 * 相对路径在加载时就转成绝对路径：执行阶段 cmd.Dir 是临时目录，相对路径会失效。
 */
func loadRuntimeConfig(explicit string) (runtimeConfig, string, error) {
	cfg := runtimeConfig{Runtimes: map[string]runtimeOverride{}}
	candidates := []string{}
	if explicit != "" {
		candidates = append(candidates, explicit)
	} else {
		candidates = append(candidates, "runtimes.local.json", "runtimes.json")
	}
	for _, p := range candidates {
		data, err := os.ReadFile(p)
		if errors.Is(err, os.ErrNotExist) {
			if explicit != "" {
				return cfg, "", fmt.Errorf("指定的运行时配置文件不存在：%s", p)
			}
			continue
		}
		if err != nil {
			return cfg, "", fmt.Errorf("读取运行时配置 %s 失败：%w", p, err)
		}
		if err := json.Unmarshal(data, &cfg); err != nil {
			return cfg, "", fmt.Errorf("运行时配置 %s 不是合法 JSON：%w", p, err)
		}
		if cfg.Runtimes == nil {
			cfg.Runtimes = map[string]runtimeOverride{}
		}
		for lang, ov := range cfg.Runtimes {
			if strings.TrimSpace(ov.Path) == "" {
				continue
			}
			abs, err := filepath.Abs(strings.TrimSpace(ov.Path))
			if err != nil {
				return cfg, "", fmt.Errorf("运行时配置 %s 里 %s.path 无法转绝对路径：%w", p, lang, err)
			}
			ov.Path = abs
			cfg.Runtimes[lang] = ov
		}
		return cfg, p, nil
	}
	return cfg, "", nil
}

// ---------------------------------------------------------------- 线协议

type runtimeEntry struct {
	Language string   `json:"language"`
	Version  string   `json:"version"`
	Aliases  []string `json:"aliases"`
	/** A′ 扩展：config = 配置里指定了 path；path = 从 PATH 找到。便于核对便携式配置是否生效。 */
	Source string `json:"source,omitempty"`
	/** A′ 扩展：运行时自报的 OS 风味（perl 的 $^O = cygwin / MSWin32 / linux），空 = 该语言不探测。 */
	Flavor string `json:"flavor,omitempty"`
}

type requestFile struct {
	Name     string `json:"name"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

type executeRequest struct {
	Language           string        `json:"language"`
	Version            string        `json:"version"`
	Files              []requestFile `json:"files"`
	Stdin              string        `json:"stdin"`
	Args               []string      `json:"args"`
	CompileTimeout     int           `json:"compile_timeout"`
	RunTimeout         int           `json:"run_timeout"`
	CompileCPUTime     int           `json:"compile_cpu_time"`
	RunCPUTime         int           `json:"run_cpu_time"`
	CompileMemoryLimit int64         `json:"compile_memory_limit"`
	RunMemoryLimit     int64         `json:"run_memory_limit"`
	OutputMaxSize      int           `json:"output_max_size"`
}

type stage struct {
	Stdout   string  `json:"stdout"`
	Stderr   string  `json:"stderr"`
	Output   string  `json:"output"`
	Code     *int    `json:"code"`
	Signal   *string `json:"signal"`
	Status   *string `json:"status"`
	Message  *string `json:"message"`
	CPUTime  *int    `json:"cpu_time,omitempty"`
	WallTime *int    `json:"wall_time,omitempty"`
	Memory   *int64  `json:"memory,omitempty"`
}

type executeResponse struct {
	Language string            `json:"language"`
	Version  string            `json:"version"`
	Run      stage             `json:"run"`
	Compile  *stage            `json:"compile,omitempty"`
	Probes   map[string]string `json:"probes,omitempty"`
}

// ---------------------------------------------------------------- 运行时规格表

/**
 * 脚本型入口的包装启动器：Windows CreateProcess 不认 `#!/bin/sh`，这类入口
 * （Cygwin /usr/bin/r、MSYS2 的脚本、WSL 的 .sh）必须由解释器显式启动。
 * name 是真正 exec 的程序，argv 是加在业务参数之前的前缀参数。
 * 这是通用机制，不绑定任何语言；探测与运行共用同一份转换，避免「探测能跑执行挂」。
 */
type launcher struct {
	name string
	argv []string
}

/** 一个执行阶段要跑什么。env 由 node.stageEnv(spec, tool) 统一生成，不在 plan 里散落。 */
type execPlan struct {
	name string
	argv []string
	tag  string
	/** 可选：wrap 存在时真正 exec 的是 wrap.name，参数为 wrap.argv + argv。 */
	wrap *launcher
}

type runtimeSpec struct {
	language   string
	aliases    []string
	execName   string   // PATH 回退时找的名字
	detectArgs []string // 版本探测命令
	versionRe  *regexp.Regexp
	/** 可选：从同一次探测输出里解析「宿主风味」（如 perl 的 $^O=cygwin），如实登记不猜。 */
	flavorRe   *regexp.Regexp
	extensions []string // 允许的文件扩展名
	entryName  string   // files[0].name 为空时的默认主文件名
	envStrip   []string // 从宿主环境里剥掉的同名变量
	envSet     []string // 强制覆盖的环境变量
	/** 可选：把配置/探测到的 tool 转成包装启动器（脚本型入口专用）。 */
	wrapEntry func(tool string) *launcher
	/** 可选：依赖 tool 绝对路径才能算出的环境变量（如 Cygwin 的 PATH / HOME）。 */
	envFromTool func(tool string) []string
	probeExtra  map[string]string
	prepare     func(dir, version string) error           // 生成 go.mod 之类
	compile     func(dir, exeName, tool string) *execPlan // nil = 单阶段语言
	run         func(dir, exeName, entry, tool string, args []string) execPlan
}

/**
 * Cygwin 脚本入口的通用包装：同目录必须有 sh.exe（bash 的硬链接）。
 * ★ 不能把脚本路径交给 Windows 直接 exec —— 会报 WinError 193「不是有效的 Win32 应用程序」。
 */
func cygwinShellWrap(tool string) *launcher {
	dir := filepath.Dir(tool)
	sh := "sh.exe"
	if runtime.GOOS != "windows" {
		sh = "sh"
	}
	return &launcher{name: filepath.Join(dir, sh), argv: []string{tool}}
}

/**
 * Cygwin 程序从 Git Bash（MSYS2）环境启动会被 PATH / argv 路径自动转换污染：
 * 实测 `sh.exe <r> --version` 返回 127 且 stdout/stderr 全空；换成这套干净环境后
 * 90ms 正常输出。⇒ PATH 里 Cygwin bin 必须优先，MSYSTEM / MSYS2_* 一律剥掉。
 * 这是通用能力，任何「非原生 POSIX 运行时」都能复用，不写死 R。
 */
func cygwinCleanEnv(tool string) []string {
	bin := filepath.Dir(tool)
	root := filepath.Dir(bin)
	sysroot := os.Getenv("SystemRoot")
	if sysroot == "" {
		sysroot = `C:\Windows`
	}
	return []string{
		"PATH=" + bin + ";" + filepath.Join(sysroot, "System32") + ";" + sysroot,
		"HOME=" + filepath.Join(root, "home"),
		"CYGWIN=nodosfilewarning",
	}
}

var safeFileName = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

/** 加一门语言 = 在这里加一条 spec + 前端五步；execute() 本身不再有语言分支。 */
func builtinSpecs() []*runtimeSpec {
	return []*runtimeSpec{
		{
			language:   "go",
			aliases:    []string{"golang"},
			execName:   "go",
			detectArgs: []string{"version"},
			versionRe:  regexp.MustCompile(`go([0-9]+\.[0-9]+(?:\.[0-9]+)?)`),
			extensions: []string{".go"},
			entryName:  "main.go",
			envStrip:   []string{"GOPROXY", "GOTOOLCHAIN", "GOWORK", "GOFLAGS", "GOSUMDB", "CGO_ENABLED"},
			envSet: []string{
				"GOPROXY=off", "GOTOOLCHAIN=local", "GOWORK=off", "GOSUMDB=off", "CGO_ENABLED=0",
			},
			probeExtra: map[string]string{
				"stages":  "build+run",
				"network": "GOPROXY=off,GOTOOLCHAIN=local",
			},
			prepare: func(dir, version string) error {
				minor := version
				if parts := strings.Split(version, "."); len(parts) >= 2 {
					minor = parts[0] + "." + parts[1]
				}
				return os.WriteFile(filepath.Join(dir, "go.mod"),
					[]byte("module playground\n\ngo "+minor+"\n"), 0o644)
			},
			compile: func(dir, exeName, tool string) *execPlan {
				return &execPlan{name: tool, argv: []string{"build", "-o", exeName, "."}, tag: "compile"}
			},
			run: func(dir, exeName, entry, tool string, args []string) execPlan {
				// exeName 由 execute() 统一补好 Windows 后缀：compile 与 run 必须用同一个名字，
				// 否则 go build -o program 生成的文件，run 阶段会去找不存在的 program.exe。
				return execPlan{name: filepath.Join(dir, exeName), argv: args, tag: "run"}
			},
		},
		{
			language:   "php",
			aliases:    []string{"php8"},
			execName:   "php",
			detectArgs: []string{"-r", "echo PHP_VERSION;"},
			versionRe:  regexp.MustCompile(`([0-9]+\.[0-9]+(?:\.[0-9]+)?)`),
			extensions: []string{".php"},
			entryName:  "main.php",
			// PHP 不外联靠 -d allow_url_fopen=0 / allow_url_include=0；curl / sockets 扩展
			// 仍在，A′ 本来就没有内核级网络隔离。如实登记，不假装「零外联」。
			probeExtra: map[string]string{
				"stages":  "run",
				"network": "allow_url_fopen=0,allow_url_include=0;curl/sockets-not-enforced",
				"phpIni":  "host-default",
			},
			run: func(dir, exeName, entry, tool string, args []string) execPlan {
				argv := []string{
					"-d", "allow_url_fopen=0",
					"-d", "allow_url_include=0",
					"-d", "display_errors=stderr",
					"-d", "html_errors=0",
					"-d", "log_errors=0",
					entry,
				}
				argv = append(argv, args...)
				return execPlan{name: tool, argv: argv, tag: "run"}
			},
		},
		{
			language: "perl",
			aliases:  []string{"perl5"},
			execName: "perl",
			// 一次探测同时拿版本与宿主风味：$^V=v5.32.1，$^O=cygwin / MSWin32 / linux。
			// 不硬编码「这是 Cygwin」——同一条 spec 也能挂 Strawberry / ActivePerl / Linux perl。
			detectArgs: []string{"-e", `printf "%s|%s\n", $^V, $^O;`},
			versionRe:  regexp.MustCompile(`v?([0-9]+\.[0-9]+\.[0-9]+)`),
			flavorRe:   regexp.MustCompile(`\|([A-Za-z0-9_]+)`),
			extensions: []string{".pl"},
			entryName:  "main.pl",
			// 剥掉宿主的模块搜索路径，避免把机器上装的第三方模块悄悄带进执行环境。
			envStrip: []string{"PERL5LIB", "PERL5OPT", "PERLLIB", "PERL_LOCAL_LIB_ROOT", "PERL_MM_OPT"},
			probeExtra: map[string]string{
				"stages":      "run",
				"network":     "no-enforcement;IO::Socket-available",
				"flavorFrom":  "$^O",
				"includePath": "-I.",
			},
			run: func(dir, exeName, entry, tool string, args []string) execPlan {
				// Perl 5.26+ 把 . 从 @INC 移除了；不显式 -I. 的话 require 'helper.pl' 会失败。
				// 本地可信代码片段，加回当前目录是为了与 Go/PHP 的「附加文件同目录」语义一致。
				argv := []string{"-I", ".", entry}
				argv = append(argv, args...)
				return execPlan{name: tool, argv: argv, tag: "run"}
			},
		},
		{
			language: "r",
			aliases:  []string{"rlang", "rscript"},
			execName: "r",
			// --version 输出里同时带版本与 Platform 行（x86_64-pc-cygwin）；
			// 风味由运行时自报，不硬编码，换 Linux / mingw 的 R 同一条 spec 不用改。
			detectArgs: []string{"--version"},
			versionRe:  regexp.MustCompile(`R version ([0-9]+\.[0-9]+(?:\.[0-9]+)?)`),
			flavorRe:   regexp.MustCompile(`(?i)Platform: [^ ]*?(cygwin|mingw|linux|darwin|windows)`),
			extensions: []string{".R", ".r"},
			entryName:  "main.R",
			// ★ 脚本型入口：r 是 #!/bin/sh wrapper（8.9 KB），不是 PE 可执行文件。
			// Windows 直接 exec 会报 WinError 193；必须由同目录 sh.exe 显式启动。
			wrapEntry:   cygwinShellWrap,
			envFromTool: cygwinCleanEnv,
			// 剥掉宿主 MSYS2 的 PATH 与 R 的用户级配置：PATH 由 envFromTool 重设成 Cygwin bin 优先。
			// ★ BASH_ENV 是关键：宿主注入的 shell-runtime-bash-env.sh 会被 Cygwin sh 自动 source，
			// 把 WorkBuddy 的 safe-bin（MSYS2 版 CRLF 脚本）重新塞回 PATH，R 启动时调用 rm
			// 就会命中它，stderr 刷一屏 "$'\r': command not found"。不剥掉等于环境净化白做。
			envStrip: []string{
				"PATH", "HOME", "CYGWIN", "MSYSTEM", "MSYS2_ARG_CONV_EXCL", "MSYS_NO_PATHCONV",
				"BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "SHELL", "MSYS2_PATH_TYPE",
				"R_HOME", "R_LIBS", "R_LIBS_USER", "R_PROFILE", "R_PROFILE_USER",
				"R_ENVIRON", "R_ENVIRON_USER", "R_DEFAULT_PACKAGES",
			},
			probeExtra: map[string]string{
				"stages":         "run",
				"entryKind":      "shell-script;#!/bin/sh",
				"wrapper":        "sh.exe <script>",
				"network":        "no-enforcement;serverSocket-available",
				"flavorFrom":     "R --version / Platform",
				"startupWarning": "host-specific;stats-namespace-may-be-unavailable",
			},
			run: func(dir, exeName, entry, tool string, args []string) execPlan {
				// --vanilla 不读 ~/.Rprofile / .Renviron / 工作区，--slave 压掉 banner。
				// ★ 刻意不设 R_DEFAULT_PACKAGES 去掩盖启动告警：宿主缺 cyglapack-0.dll 时
				// stats 命名空间加载失败，必须让 stderr 如实说出来，不能假装 R 是完整的。
				argv := []string{"--vanilla", "--slave", "--file=" + entry}
				argv = append(argv, args...)
				return execPlan{name: tool, argv: argv, tag: "run", wrap: cygwinShellWrap(tool)}
			},
		},
	}
}

// ---------------------------------------------------------------- 节点

type resolvedRuntime struct {
	language string
	version  string
	aliases  []string
	source   string
	tool     string
	/** 运行时自报的宿主风味；空字符串表示该语言没有配置 flavorRe。 */
	flavor string
}

type node struct {
	token       string
	config      runtimeConfig
	configPath  string
	specs       []*runtimeSpec
	byLanguage  map[string]*runtimeSpec
	maxParallel chan struct{}
}

func strPtr(s string) *string { return &s }
func intPtr(i int) *int       { return &i }

/**
 * ★ 动态探测：这一刻能不能跑，就按这一刻报。
 * 「关」必须是第一句：disabled 优先于任何 PATH/配置探测，避免「以为关了其实冒出来」。
 */
func (n *node) resolveRuntime(spec *runtimeSpec) (*resolvedRuntime, error) {
	ov := n.config.Runtimes[spec.language]
	if ov.Disabled {
		return nil, fmt.Errorf("%s 已在运行时配置里显式 disabled", spec.language)
	}

	tool, source := "", ""
	if ov.Path != "" {
		fi, err := os.Stat(ov.Path)
		if err != nil || !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("%s 配置的 path 不是可执行文件：%s", spec.language, ov.Path)
		}
		tool, source = ov.Path, "config"
	} else {
		p, err := exec.LookPath(spec.execName)
		if err != nil {
			return nil, fmt.Errorf("PATH 里没有 %s；可在 runtimes.local.json 给 %s 配 path", spec.execName, spec.language)
		}
		tool, source = p, "path"
	}

	// ★ 探测与执行必须用同一份包装 + 同一份净化环境，否则会出现
	// 「版本表能报出来、真执行却 127」这种能力表撒谎。
	name, argv := tool, append([]string{}, spec.detectArgs...)
	if spec.wrapEntry != nil {
		w := spec.wrapEntry(tool)
		if fi, statErr := os.Stat(w.name); statErr != nil || fi.IsDir() {
			return nil, fmt.Errorf("%s 的脚本包装器不可用：%s（解释器要与入口同目录）", spec.language, w.name)
		}
		name = w.name
		argv = append(append([]string{}, w.argv...), argv...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, argv...)
	cmd.Env = n.stageEnv(spec, tool)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%s 版本探测失败（%s）：%v", spec.language, tool, err)
	}
	m := spec.versionRe.FindSubmatch(out)
	if m == nil {
		return nil, fmt.Errorf("无法解析 %s 版本输出：%q", spec.language, strings.TrimSpace(string(out)))
	}
	flavor := ""
	if spec.flavorRe != nil {
		if f := spec.flavorRe.FindSubmatch(out); f != nil {
			flavor = string(f[1])
		}
	}
	return &resolvedRuntime{
		language: spec.language,
		version:  string(m[1]),
		aliases:  spec.aliases,
		source:   source,
		tool:     tool,
		flavor:   flavor,
	}, nil
}

/** GET /api/v2/runtimes 与 /health 共用；探测失败的详情只进 /health，不污染线协议。 */
func (n *node) detectAll() ([]runtimeEntry, map[string]string) {
	entries := make([]runtimeEntry, 0, len(n.specs))
	missing := map[string]string{}
	for _, spec := range n.specs {
		rt, err := n.resolveRuntime(spec)
		if err != nil {
			missing[spec.language] = err.Error()
			continue
		}
		entries = append(entries, runtimeEntry{
			Language: rt.language, Version: rt.version, Aliases: rt.aliases,
			Source: rt.source, Flavor: rt.flavor,
		})
	}
	return entries, missing
}

/** Piston v2 契约：files[].name 不含路径。扩展名按语言白名单，不再写死 .go。 */
func validateFiles(files []requestFile, spec *runtimeSpec) error {
	if len(files) == 0 {
		return errors.New("files 不能为空，第一个文件是主文件")
	}
	seen := map[string]bool{}
	for i, f := range files {
		name := f.Name
		if name == "" {
			name = spec.entryName
		}
		if strings.Contains(name, "..") || !safeFileName.MatchString(name) ||
			!contains(spec.extensions, filepath.Ext(name)) {
			return fmt.Errorf("files[%d].name 非法（只接受纯文件名，扩展名限 %s）：%q",
				i, strings.Join(spec.extensions, "/"), name)
		}
		if seen[name] {
			return fmt.Errorf("文件名重复：%q", name)
		}
		seen[name] = true
		if f.Encoding != "" && f.Encoding != "utf8" {
			return fmt.Errorf("files[%d].encoding 只支持 utf8，收到 %q", i, f.Encoding)
		}
	}
	return nil
}

func (n *node) stageEnv(spec *runtimeSpec, tool string) []string {
	env := os.Environ()
	// ★ Windows 环境变量名大小写不敏感（Path / PATH / path 是同一个键），
	// 用 strings.ToUpper 归一化，否则「剥了 PATH 但漏了 Path」会把宿主 PATH 放进来。
	strip := map[string]bool{}
	for _, k := range spec.envStrip {
		strip[strings.ToUpper(k)] = true
	}
	set := append([]string{}, spec.envSet...)
	if spec.envFromTool != nil {
		set = append(set, spec.envFromTool(tool)...)
	}
	out := make([]string, 0, len(env)+len(set))
	for _, kv := range env {
		upper := strings.ToUpper(strings.SplitN(kv, "=", 2)[0])
		// ★ 宿主可能把 shell 函数以 BASH_FUNC_xxx%% 导出（WorkBuddy 的安全删除守卫
		// 就是 BASH_FUNC_RM%% / RMDIR%% / UNLINK%%）。Cygwin bash 启动时会 import 它们，
		// 覆盖 rm 等内建命令名，让 R 启动时调用的 rm 命中 MSYS2 版 CRLF 脚本，
		// stderr 刷一屏 "$'\r': command not found"。A′ 不需要任何宿主导出函数，一律剥掉。
		if strip[upper] || strings.HasPrefix(upper, "BASH_FUNC_") {
			continue
		}
		out = append(out, kv)
	}
	// 追加在末尾：os/exec 的 dedupEnv 保留最后一次出现的同名键，所以 set 能覆盖宿主值。
	return append(out, set...)
}

// readCapped 最多读 max+1 字节，既实现输出截断，也不把用户代码写出的大文件整个吞进内存。
func readCapped(path string, max int) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	buf := make([]byte, max+1)
	n, _ := io.ReadFull(f, buf)
	if n > max {
		return string(buf[:max]), true
	}
	return string(buf[:n]), false
}

func failedStage(msg string) stage {
	return stage{Status: strPtr("XX"), Message: strPtr(msg)}
}

func (n *node) runStage(
	ctx context.Context,
	plan execPlan,
	dir string,
	stdin string,
	timeoutMs int,
	maxOut int,
	env []string,
) stage {
	if timeoutMs <= 0 {
		timeoutMs = 3000
	}
	if maxOut <= 0 {
		maxOut = 64 * 1024
	}
	stageCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	stdoutPath := filepath.Join(dir, plan.tag+".stdout")
	stderrPath := filepath.Join(dir, plan.tag+".stderr")
	stdinPath := filepath.Join(dir, plan.tag+".stdin")
	if err := os.WriteFile(stdinPath, []byte(stdin), 0o644); err != nil {
		return failedStage("写 stdin 失败：" + err.Error())
	}
	outFile, err := os.Create(stdoutPath)
	if err != nil {
		return failedStage("创建 stdout 文件失败：" + err.Error())
	}
	defer outFile.Close()
	errFile, err := os.Create(stderrPath)
	if err != nil {
		return failedStage("创建 stderr 文件失败：" + err.Error())
	}
	defer errFile.Close()
	inFile, err := os.Open(stdinPath)
	if err != nil {
		return failedStage("打开 stdin 文件失败：" + err.Error())
	}
	defer inFile.Close()

	execName, execArgv := plan.name, plan.argv
	if plan.wrap != nil {
		execName = plan.wrap.name
		execArgv = append(append([]string{}, plan.wrap.argv...), plan.argv...)
	}
	cmd := exec.CommandContext(stageCtx, execName, execArgv...)
	cmd.WaitDelay = 250 * time.Millisecond
	cmd.Dir = dir
	cmd.Env = env
	// ★ 用真实 *os.File 做 stdio，不用 io.Writer + 管道：
	//   Windows 上 go build 的 compile/link 子进程会继承管道句柄，父进程退出后
	//   cmd.Wait() 仍可能等 EOF（WaitDelay 只兜 ctx 已结束的情形）。传文件句柄时
	//   Go 不建管道、不起 io.Copy goroutine，输出限额改由「文件大小看门狗 + 读回截断」保证。
	//   口径订正：本机实测满 CPU 的 for{} 会让 go build 与 TerminateProcess 各慢约 5 秒，
	//   这与管道无关，是 Windows 环境开销；所以超时判据只押 status/signal，不押 wall_time 毫秒数。
	cmd.Stdout = outFile
	cmd.Stderr = errFile
	cmd.Stdin = inFile

	started := time.Now()
	startErr := cmd.Start()
	var killedByOutput atomic.Bool
	stop := make(chan struct{})
	if startErr == nil {
		go func() {
			tick := time.NewTicker(25 * time.Millisecond)
			defer tick.Stop()
			for {
				select {
				case <-tick.C:
					big := func(p string) bool {
						fi, e := os.Stat(p)
						return e == nil && fi.Size() > int64(maxOut*2)
					}
					if big(stdoutPath) || big(stderrPath) {
						killedByOutput.Store(true)
						_ = cmd.Process.Kill()
						return
					}
				case <-stop:
					return
				}
			}
		}()
	}
	runErr := startErr
	if startErr == nil {
		runErr = cmd.Wait()
	}
	close(stop)
	elapsed := int(time.Since(started).Milliseconds())
	stdout, outOverflow := readCapped(stdoutPath, maxOut)
	stderr, errOverflow := readCapped(stderrPath, maxOut)

	s := stage{
		Stdout:   stdout,
		Stderr:   stderr,
		Output:   stdout + stderr,
		WallTime: intPtr(elapsed),
	}

	var execErr *exec.Error
	if errors.As(runErr, &execErr) {
		s.Status = strPtr("XX")
		s.Message = strPtr("无法启动进程：" + runErr.Error())
		return s
	}
	if stageCtx.Err() == context.DeadlineExceeded {
		s.Status = strPtr("TO")
		s.Signal = strPtr("SIGKILL")
		s.Message = strPtr(fmt.Sprintf("%s 阶段超过 %dms 被终止", filepath.Base(plan.name), timeoutMs))
		return s
	}
	if killedByOutput.Load() || outOverflow || errOverflow {
		s.Status = strPtr("OL")
		s.Message = strPtr(fmt.Sprintf("输出超过 %d 字节被截断", maxOut))
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			code := exitErr.ExitCode()
			s.Code = &code
		} else if s.Status == nil {
			s.Status = strPtr("XX")
			s.Message = strPtr(runErr.Error())
		}
	} else {
		code := 0
		s.Code = &code
	}
	return s
}

func commonProbes() map[string]string {
	return map[string]string{
		"engine":            "local.process.v1",
		"isolation":         "process-only",
		"trust":             "advisory",
		"enforcedLimits":    "wall-time,output-bytes,concurrency",
		"unsupportedLimits": "cpu-time,memory-bytes,process-count",
		"memoryCapability":  "no-memory-cap",
		"cpuTime":           "unavailable",
		"encoding":          "utf8-only",
		"tempDir":           "per-request,deferred-cleanup",
		"processTreeKill":   "not-guaranteed-on-windows",
	}
}

func (n *node) execute(req executeRequest) (int, any) {
	spec := n.byLanguage[req.Language]
	if spec == nil {
		return http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("%s runtime is unknown（A′ 只登记 %v）", req.Language, n.languageNames()),
		}
	}
	// 每次执行也重探测：便携式运行时被拔走后，不会拿缓存的旧路径去跑。
	rt, err := n.resolveRuntime(spec)
	if err != nil {
		return http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("%s runtime is unknown：%v", req.Language, err),
		}
	}
	if err := validateFiles(req.Files, spec); err != nil {
		return http.StatusBadRequest, map[string]string{"message": err.Error()}
	}
	dir, err := os.MkdirTemp("", "pg-local-*")
	if err != nil {
		return http.StatusInternalServerError, map[string]string{"message": "创建临时目录失败：" + err.Error()}
	}
	defer os.RemoveAll(dir)

	if spec.prepare != nil {
		if err := spec.prepare(dir, rt.version); err != nil {
			return http.StatusInternalServerError, map[string]string{"message": err.Error()}
		}
	}
	for _, f := range req.Files {
		name := f.Name
		if name == "" {
			name = spec.entryName
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(f.Content), 0o644); err != nil {
			return http.StatusInternalServerError, map[string]string{"message": err.Error()}
		}
	}

	exeName := "program"
	if runtime.GOOS == "windows" {
		exeName += ".exe"
	}
	entry := req.Files[0].Name
	if entry == "" {
		entry = spec.entryName
	}

	probes := commonProbes()
	probes["runtimePathSource"] = rt.source
	probes["runtimeVersion"] = rt.version
	if rt.flavor != "" {
		probes["runtimeFlavor"] = rt.flavor
	}
	for k, v := range spec.probeExtra {
		probes[k] = v
	}
	resp := executeResponse{
		Language: spec.language,
		Version:  rt.version,
		Probes:   probes,
	}
	env := n.stageEnv(spec, rt.tool)

	if spec.compile != nil {
		compileOut := n.runStage(
			context.Background(), *spec.compile(dir, exeName, rt.tool), dir, "",
			req.CompileTimeout, req.OutputMaxSize, env,
		)
		// go build 非零退出是 ExitError，runStage 按 Piston 语义只填 code、不填 status；
		// 但编译阶段必须让前端的 mapExecuteResponse 判出失败，否则会去跑一个不存在的 exe。
		if compileOut.Code != nil && *compileOut.Code != 0 && compileOut.Status == nil {
			compileOut.Status = strPtr("RE")
			compileOut.Message = strPtr("编译失败，退出码 " + strconv.Itoa(*compileOut.Code))
		}
		resp.Compile = &compileOut
		// 编译失败：run 给空壳，由 compile.status 决定总体状态，绝不谎报「执行过」。
		if compileOut.Status != nil {
			resp.Run = stage{
				Status:  nil,
				Message: strPtr("编译阶段未通过，未进入运行阶段"),
			}
			return http.StatusOK, resp
		}
	}

	runOut := n.runStage(
		context.Background(), spec.run(dir, exeName, entry, rt.tool, req.Args), dir, req.Stdin,
		req.RunTimeout, req.OutputMaxSize, env,
	)
	resp.Run = runOut
	return http.StatusOK, resp
}

func (n *node) languageNames() []string {
	out := make([]string, 0, len(n.specs))
	for _, s := range n.specs {
		out = append(out, s.language)
	}
	return out
}

// ---------------------------------------------------------------- HTTP

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func (n *node) cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if n.token != "" {
			want := "Bearer " + n.token
			if r.Header.Get("Authorization") != want {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized：token 不匹配"})
				return
			}
		}
		next(w, r)
	}
}

func (n *node) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v2/runtimes", n.cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "only GET"})
			return
		}
		entries, _ := n.detectAll()
		writeJSON(w, http.StatusOK, entries)
	}))
	mux.HandleFunc("/api/v2/execute", n.cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "only POST"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
		var req executeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "请求体不是合法 JSON：" + err.Error()})
			return
		}
		select {
		case n.maxParallel <- struct{}{}:
			defer func() { <-n.maxParallel }()
		case <-r.Context().Done():
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "节点繁忙，请求被取消"})
			return
		}
		code, body := n.execute(req)
		writeJSON(w, code, body)
	}))
	mux.HandleFunc("/health", n.cors(func(w http.ResponseWriter, r *http.Request) {
		entries, missing := n.detectAll()
		config := n.configPath
		if config == "" {
			config = "(无配置文件，全部回退 PATH)"
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "engine": "local.process.v1",
			"isolation": "process-only", "trust": "advisory",
			"config": config, "runtimes": entries, "missing": missing,
		})
	}))
	return mux
}

func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "" {
		return false
	}
	ip := net.ParseIP(host)
	if ip != nil {
		return ip.IsLoopback()
	}
	return strings.EqualFold(host, "localhost")
}

func main() {
	addr := flag.String("addr", "127.0.0.1:2000", "监听地址（只允许回环）")
	token := flag.String("token", defaultToken, "Bearer token；空串关闭鉴权（不推荐）")
	parallel := flag.Int("max-parallel", 4, "最大并发执行数")
	configFlag := flag.String("config", "", "运行时配置文件；默认按 runtimes.local.json → runtimes.json 查找")
	flag.Parse()

	if !isLoopback(*addr) {
		log.Fatalf("拒绝启动：A′ 节点只能绑回环地址，收到 %q。需要跨机访问请改用官方 Docker + isolate。", *addr)
	}
	explicit := *configFlag
	if explicit == "" {
		explicit = os.Getenv("PLAYGROUND_RUNTIMES_CONFIG")
	}
	cfg, cfgPath, err := loadRuntimeConfig(explicit)
	if err != nil {
		log.Fatalf("运行时配置加载失败：%v", err)
	}
	specs := builtinSpecs()
	byLang := map[string]*runtimeSpec{}
	for _, s := range specs {
		byLang[s.language] = s
	}
	for lang := range cfg.Runtimes {
		if _, ok := byLang[lang]; !ok {
			log.Printf("警告：运行时配置里的 %q 没有对应的内建 spec，已忽略（检查拼写）", lang)
		}
	}
	n := &node{
		token:       *token,
		config:      cfg,
		configPath:  cfgPath,
		specs:       specs,
		byLanguage:  byLang,
		maxParallel: make(chan struct{}, *parallel),
	}

	entries, missing := n.detectAll()
	log.Printf("A′ 执行节点启动 addr=%s parallel=%d isolation=process-only trust=advisory token=%t",
		*addr, *parallel, n.token != "")
	log.Printf("运行时配置=%s 已登记=%d 未就绪=%d", cfgPath, len(entries), len(missing))
	for _, e := range entries {
		log.Printf("  [就绪] %-4s %-10s source=%s", e.Language, e.Version, e.Source)
	}
	for lang, why := range missing {
		log.Printf("  [置灰] %-4s %s", lang, why)
	}
	log.Printf("提示：这是非 Docker 的进程级执行节点，只跑可信代码；不要对公网开放。详见 README.md / 手册第十三章。")

	srv := &http.Server{
		Addr:              *addr,
		Handler:           n.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("监听失败：%v", err)
	}
}
