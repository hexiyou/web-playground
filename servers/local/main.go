// Command playground-local 是 A′ 本机进程执行节点：Piston v2 兼容子集、非 Docker、
// 跨平台单二进制。它只服务「团队内几个人的可信代码片段」，不做内核级隔离。
//
// 决策分叉与回切条件见项目根 playground-architecture-analysis.html 第十三章。
// 真值手册见同目录 README.md。
//
// 硬边界（改之前先读文档）：
//  1. 只绑回环地址，非 loopback 直接拒绝启动；
//  2. 默认固定 token，只防本机其它页面误调，不是安全边界；
//  3. 强制 GOPROXY=off / GOTOOLCHAIN=local，编译期不外联；
//  4. 进程级墙钟 + 输出字节 + 并发上限，没有 CPU/内存/进程数内核限额；
//  5. 每次执行独立临时目录，defer 清理；文件名按 Piston 契约拒绝一切路径。
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

type runtimeEntry struct {
	Language string   `json:"language"`
	Version  string   `json:"version"`
	Aliases  []string `json:"aliases"`
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

type node struct {
	token       string
	goVersion   string
	maxParallel chan struct{}
}

func strPtr(s string) *string { return &s }
func intPtr(i int) *int       { return &i }

func detectGoVersion() (string, error) {
	out, err := exec.Command("go", "version").Output()
	if err != nil {
		return "", fmt.Errorf("本机没有可用的 go 命令：%w", err)
	}
	m := regexp.MustCompile(`go([0-9]+\.[0-9]+(?:\.[0-9]+)?)`).FindSubmatch(out)
	if m == nil {
		return "", fmt.Errorf("无法解析 go version 输出：%s", strings.TrimSpace(string(out)))
	}
	return string(m[1]), nil
}

// 纯文件名，且必须是 .go。Piston v2 契约也要求 files[].name 不含路径。
var safeGoName = regexp.MustCompile(`^[A-Za-z0-9_.-]+\.go$`)

func validateFiles(files []requestFile) error {
	if len(files) == 0 {
		return errors.New("files 不能为空，第一个文件是主文件")
	}
	seen := map[string]bool{}
	for i, f := range files {
		name := f.Name
		if name == "" {
			name = "main.go"
		}
		if strings.Contains(name, "..") || !safeGoName.MatchString(name) {
			return fmt.Errorf("files[%d].name 非法（只允许纯 .go 文件名）：%q", i, name)
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

func (n *node) buildEnv() []string {
	env := os.Environ()
	// 去掉外部可能注入的同名变量，再统一覆盖，避免「以为关了其实没关」。
	out := make([]string, 0, len(env)+8)
	for _, kv := range env {
		key := strings.SplitN(kv, "=", 2)[0]
		switch key {
		case "GOPROXY", "GOTOOLCHAIN", "GOWORK", "GOFLAGS", "GOSUMDB", "CGO_ENABLED":
			continue
		}
		out = append(out, kv)
	}
	return append(out,
		"GOPROXY=off",
		"GOTOOLCHAIN=local",
		"GOWORK=off",
		"GOSUMDB=off",
		"CGO_ENABLED=0",
	)
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
	name string,
	argv []string,
	dir string,
	stdin string,
	args []string,
	timeoutMs int,
	maxOut int,
	tag string,
) stage {
	if timeoutMs <= 0 {
		timeoutMs = 3000
	}
	if maxOut <= 0 {
		maxOut = 64 * 1024
	}
	stageCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	if name != "go" {
		argv = append(argv, args...)
	}

	stdoutPath := filepath.Join(dir, tag+".stdout")
	stderrPath := filepath.Join(dir, tag+".stderr")
	stdinPath := filepath.Join(dir, tag+".stdin")
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

	cmd := exec.CommandContext(stageCtx, name, argv...)
	cmd.WaitDelay = 250 * time.Millisecond
	cmd.Dir = dir
	cmd.Env = n.buildEnv()
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
		// 文件由子进程直接写，必须看住大小，否则一段死循环输出能写满磁盘。
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
		s.Message = strPtr(fmt.Sprintf("%s 阶段超过 %dms 被终止", filepath.Base(name), timeoutMs))
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

func (n *node) execute(req executeRequest) (int, any) {
	if req.Language != "go" {
		return http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("%s runtime is unknown（A′ 首版只登记 go）", req.Language),
		}
	}
	if err := validateFiles(req.Files); err != nil {
		return http.StatusBadRequest, map[string]string{"message": err.Error()}
	}
	dir, err := os.MkdirTemp("", "pg-local-*")
	if err != nil {
		return http.StatusInternalServerError, map[string]string{"message": "创建临时目录失败：" + err.Error()}
	}
	defer os.RemoveAll(dir)

	minor := n.goVersion
	if parts := strings.Split(n.goVersion, "."); len(parts) >= 2 {
		minor = parts[0] + "." + parts[1]
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"),
		[]byte("module playground\n\ngo "+minor+"\n"), 0o644); err != nil {
		return http.StatusInternalServerError, map[string]string{"message": err.Error()}
	}
	for _, f := range req.Files {
		name := f.Name
		if name == "" {
			name = "main.go"
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(f.Content), 0o644); err != nil {
			return http.StatusInternalServerError, map[string]string{"message": err.Error()}
		}
	}

	exeName := "program"
	if runtime.GOOS == "windows" {
		exeName += ".exe"
	}
	exePath := filepath.Join(dir, exeName)

	compileOut := n.runStage(
		context.Background(), "go", []string{"build", "-o", exeName, "."}, dir, "", nil,
		req.CompileTimeout, req.OutputMaxSize, "compile",
	)
	// go build 非零退出是 ExitError，runStage 按 Piston 语义只填 code、不填 status；
	// 但编译阶段必须让前端的 mapExecuteResponse 判出失败，否则会去跑一个不存在的 exe。
	if compileOut.Code != nil && *compileOut.Code != 0 && compileOut.Status == nil {
		compileOut.Status = strPtr("RE")
		compileOut.Message = strPtr("编译失败，退出码 " + strconv.Itoa(*compileOut.Code))
	}
	resp := executeResponse{
		Language: "go",
		Version:  n.goVersion,
		Compile:  &compileOut,
		Probes: map[string]string{
			"engine":            "local.process.v1",
			"isolation":         "process-only",
			"trust":             "advisory",
			"stages":            "build+run",
			"network":           "GOPROXY=off,GOTOOLCHAIN=local",
			"goVersion":         n.goVersion,
			"enforcedLimits":    "wall-time,output-bytes,concurrency",
			"unsupportedLimits": "cpu-time,memory-bytes,process-count",
			"memoryCapability":  "no-memory-cap",
			"cpuTime":           "unavailable",
			"encoding":          "utf8-only",
			"tempDir":           "per-request,deferred-cleanup",
			"processTreeKill":   "not-guaranteed-on-windows",
		},
	}

	// 编译失败：run 给空壳，由 compile.status 决定总体状态，绝不谎报「执行过」。
	if compileOut.Status != nil {
		resp.Run = stage{
			Status:  nil,
			Message: strPtr("编译阶段未通过，未进入运行阶段"),
		}
		return http.StatusOK, resp
	}

	runOut := n.runStage(
		context.Background(), exePath, nil, dir, req.Stdin, req.Args,
		req.RunTimeout, req.OutputMaxSize, "run",
	)
	resp.Run = runOut
	return http.StatusOK, resp
}

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
		writeJSON(w, http.StatusOK, []runtimeEntry{
			{Language: "go", Version: n.goVersion, Aliases: []string{"golang"}},
		})
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
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "engine": "local.process.v1", "goVersion": n.goVersion,
			"isolation": "process-only", "trust": "advisory",
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
	flag.Parse()

	if !isLoopback(*addr) {
		log.Fatalf("拒绝启动：A′ 节点只能绑回环地址，收到 %q。需要跨机访问请改用官方 Docker + isolate。", *addr)
	}
	goVersion, err := detectGoVersion()
	if err != nil {
		log.Fatalf("Go 运行时探测失败：%v", err)
	}
	n := &node{
		token:       *token,
		goVersion:   goVersion,
		maxParallel: make(chan struct{}, *parallel),
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           n.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	log.Printf("A′ 执行节点启动 addr=%s go=%s parallel=%d isolation=process-only trust=advisory token=%t",
		*addr, goVersion, *parallel, n.token != "")
	log.Printf("提示：这是非 Docker 的进程级执行节点，只跑可信代码；不要对公网开放。详见 README.md / 手册第十三章。")
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("监听失败：%v", err)
	}
}
