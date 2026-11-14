package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	appID       = "nai-pocket-library.desktop"
	appVersion  = "1.3.20"
	desktopHost = "127.0.0.1:17619"
	desktopURL  = "http://" + desktopHost
	homeURL     = desktopURL + "/index.html"

	contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	maxHeaderBytes        = 64 * 1024
	maxErrorBody          = 64 * 1024
)

var (
	errResourceTooLarge = errors.New("resource exceeds its size limit")
	cacheWriteMu        sync.Mutex
)

type routeError struct {
	status  int
	message string
}

func (e *routeError) Error() string { return e.message }

func badRequest(message string) error {
	return &routeError{status: http.StatusBadRequest, message: message}
}

func notFound(message string) error {
	return &routeError{status: http.StatusNotFound, message: message}
}

func unavailable(message string) error {
	return &routeError{status: http.StatusServiceUnavailable, message: message}
}

func upstreamFailure(message string) error {
	return &routeError{status: http.StatusBadGateway, message: message}
}

type application struct {
	webRoot  string
	korean   *koreanLibrary
	nax      *naxLibrary
	danbooru *http.ServeMux
}

func newApplication(webRoot, cacheRoot string) *application {
	galleries := http.NewServeMux()
	registerDanbooru(galleries)
	return &application{
		webRoot:  webRoot,
		korean:   newKoreanLibrary(webRoot, cacheRoot),
		nax:      newNAXLibrary(cacheRoot),
		danbooru: galleries,
	}
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	webFlag := flag.String("web", "", "web asset directory (defaults to web next to the executable)")
	noBrowser := flag.Bool("no-browser", false, "serve without opening a browser")
	flag.Parse()
	if flag.NArg() != 0 {
		fatal("不接受位置参数")
	}

	webRoot, err := resolveWebRoot(*webFlag)
	if err != nil {
		fatal("无法读取 web 资源：%v", err)
	}
	if err := validateWebRoot(webRoot); err != nil {
		fatal("web 资源不完整：%v", err)
	}
	cacheRoot, err := applicationCacheRoot()
	if err != nil {
		fatal("无法创建本地缓存目录：%v", err)
	}

	listener, existing, err := acquireListener()
	if err != nil {
		fatal("%v；不会打开其他程序的页面", err)
	}
	if existing {
		log.Printf("检测到同一 App 已在运行，重新打开 %s", homeURL)
		if !*noBrowser {
			if _, err := openApplicationWindow(cacheRoot); err != nil {
				log.Printf("无法重新打开窗口：%v；请手动访问 %s", err, homeURL)
			}
		}
		return
	}

	app := newApplication(webRoot, cacheRoot)
	server := &http.Server{
		Handler:           app,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      50 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    maxHeaderBytes,
	}

	serveErrors := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErrors <- err
	}()

	log.Printf("NAI 口袋词库 %s 正在监听 %s", appVersion, homeURL)
	var browserDone <-chan struct{}
	if !*noBrowser {
		browserDone, err = openApplicationWindow(cacheRoot)
		if err != nil {
			log.Printf("无法自动打开浏览器：%v；请手动访问 %s", err, homeURL)
		}
	}

	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)

	var stoppedBy string
	select {
	case <-interrupts:
		stoppedBy = "收到退出信号"
	case <-browserDone:
		stoppedBy = "独立窗口已关闭"
	case err := <-serveErrors:
		if err != nil {
			log.Printf("本地服务异常：%v", err)
		}
		return
	}

	log.Print(stoppedBy)
	shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		log.Printf("本地服务退出超时：%v", err)
		_ = server.Close()
	}
}

func resolveWebRoot(flagValue string) (string, error) {
	value := flagValue
	if value == "" {
		executable, err := os.Executable()
		if err != nil {
			return "", err
		}
		value = filepath.Join(filepath.Dir(executable), "web")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("不是目录")
	}
	return resolved, nil
}

func validateWebRoot(root string) error {
	index, err := secureWebPath(root, "/index.html")
	if err != nil {
		return err
	}
	info, err := os.Stat(index)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("index.html 不是普通文件")
	}
	return nil
}

func applicationCacheRoot() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	root := filepath.Join(base, "NAI-Pocket-Library")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	return root, nil
}

func acquireListener() (net.Listener, bool, error) {
	deadline := time.Now().Add(3 * time.Second)
	for {
		listener, err := net.Listen("tcp4", desktopHost)
		if err == nil {
			return listener, false, nil
		}
		if isAppRunning() {
			return nil, true, nil
		}
		if time.Now().After(deadline) {
			return nil, false, fmt.Errorf("无法绑定 %s", desktopHost)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func isAppRunning() bool {
	transport := &http.Transport{
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: time.Second}).DialContext,
		DisableKeepAlives:   true,
		DisableCompression:  true,
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        0,
		MaxIdleConnsPerHost: 0,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   2 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	defer transport.CloseIdleConnections()

	request, err := http.NewRequest(http.MethodGet, desktopURL+"/api/desktop.json", nil)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	data, err := readLimited(response.Body, maxErrorBody)
	if err != nil {
		return false
	}
	var marker desktopMarker
	if json.Unmarshal(data, &marker) != nil {
		return false
	}
	return marker.App == appID && marker.Port == 17619
}

func openApplicationWindow(cacheRoot string) (<-chan struct{}, error) {
	profile := filepath.Join(cacheRoot, "edge-profile")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return nil, err
	}
	if edge := findEdge(); edge != "" {
		command := exec.Command(edge,
			"--app="+homeURL,
			"--user-data-dir="+profile,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-mode",
		)
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := command.Start(); err != nil {
			log.Printf("Edge 独立窗口启动失败，改用默认浏览器：%v", err)
		} else {
			done := make(chan struct{})
			go func() {
				_ = command.Wait()
				close(done)
			}()
			return done, nil
		}
	}

	command := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", homeURL)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := command.Start(); err != nil {
		return nil, err
	}
	return nil, nil
}

func findEdge() string {
	if executable, err := exec.LookPath("msedge.exe"); err == nil {
		if regularFile(executable) {
			return executable
		}
	}
	var candidates []string
	for _, variable := range []string{"PROGRAMFILES", "PROGRAMFILES(X86)", "ProgramW6432", "LOCALAPPDATA"} {
		if directory := os.Getenv(variable); directory != "" {
			candidates = append(candidates, filepath.Join(directory, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	}
	for _, candidate := range candidates {
		if regularFile(candidate) {
			return candidate
		}
	}
	return ""
}

func regularFile(filename string) bool {
	info, err := os.Stat(filename)
	return err == nil && info.Mode().IsRegular()
}

func (app *application) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	headers := writer.Header()
	setSecurityHeaders(headers)
	if request.Host != desktopHost || !isLoopbackRequest(request.RemoteAddr) {
		writeAPIFailure(writer, request, http.StatusForbidden, "请求来源不受支持")
		return
	}
	if !validDecodedPath(request.URL.Path) {
		writeAPIFailure(writer, request, http.StatusBadRequest, "路径无效")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		headers.Set("Allow", "GET, HEAD")
		writeAPIFailure(writer, request, http.StatusMethodNotAllowed, "仅支持 GET 和 HEAD")
		return
	}
	if request.ContentLength > 0 || len(request.TransferEncoding) != 0 {
		request.Body.Close()
		writeAPIFailure(writer, request, http.StatusRequestEntityTooLarge, "请求体不受支持")
		return
	}

	switch request.URL.Path {
	case "/":
		headers.Set("Location", "/index.html")
		headers.Set("Cache-Control", "no-store")
		writer.WriteHeader(http.StatusFound)
		return
	case "/api/desktop.json":
		marker := desktopMarker{
			App:     appID,
			Version: appVersion,
			Port:    17619,
			Home:    homeURL,
		}
		data, _ := json.Marshal(marker)
		headers.Set("Cache-Control", "no-store")
		writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
		return
	case "/api/korean.json":
		app.serveKoreanCatalog(writer, request)
		return
	case "/api/korean-status.json":
		app.serveKoreanStatus(writer, request)
		return
	case "/api/nax.json":
		app.serveNAXCatalog(writer, request)
		return
	case "/api/tag-gallery/posts", "/api/tag-gallery/tags":
		app.danbooru.ServeHTTP(writer, request)
		return
	}

	if strings.HasPrefix(request.URL.Path, danbooruImageRoute) {
		app.danbooru.ServeHTTP(writer, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/korean-image/") {
		app.serveKoreanImage(writer, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/nax-image/") {
		app.serveNAXImage(writer, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/api/") {
		writeAPIFailure(writer, request, http.StatusNotFound, "接口不存在")
		return
	}
	app.serveStatic(writer, request)
}

type desktopMarker struct {
	App     string `json:"app"`
	Version string `json:"version"`
	Port    int    `json:"port"`
	Home    string `json:"home"`
}

func setSecurityHeaders(headers http.Header) {
	headers.Set("Content-Security-Policy", contentSecurityPolicy)
	headers.Set("Referrer-Policy", "no-referrer")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Frame-Options", "DENY")
	headers.Set("Cross-Origin-Resource-Policy", "same-origin")
	headers.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
}

func isLoopbackRequest(remoteAddress string) bool {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		return false
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func validDecodedPath(value string) bool {
	return strings.HasPrefix(value, "/") &&
		!strings.ContainsAny(value, "\\\x00") &&
		!strings.Contains(value, "//")
}

func (app *application) serveStatic(writer http.ResponseWriter, request *http.Request) {
	extension := strings.ToLower(filepath.Ext(request.URL.Path))
	switch extension {
	case ".html", ".css", ".js", ".json":
	default:
		writeAPIFailure(writer, request, http.StatusNotFound, "文件不存在")
		return
	}
	filename, err := secureWebPath(app.webRoot, request.URL.Path)
	if err != nil {
		writeAPIFailure(writer, request, http.StatusNotFound, "文件不存在")
		return
	}
	file, err := os.Open(filename)
	if err != nil {
		writeAPIFailure(writer, request, http.StatusNotFound, "文件不存在")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeAPIFailure(writer, request, http.StatusNotFound, "文件不存在")
		return
	}

	contentType := ""
	switch extension {
	case ".html":
		contentType = "text/html; charset=utf-8"
	case ".css":
		contentType = "text/css; charset=utf-8"
	case ".js":
		contentType = "text/javascript; charset=utf-8"
	case ".json":
		contentType = "application/json; charset=utf-8"
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(writer, request, filepath.Base(filename), info.ModTime(), file)
}

func secureWebPath(root, route string) (string, error) {
	if strings.ContainsAny(route, "\\\x00") {
		return "", errors.New("invalid path")
	}
	relativeRoute := strings.TrimPrefix(route, "/")
	for _, segment := range strings.Split(relativeRoute, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", errors.New("invalid path segment")
		}
	}
	clean := path.Clean("/" + relativeRoute)
	if clean == "/" {
		return "", errors.New("missing filename")
	}
	relativePath := filepath.FromSlash(strings.TrimPrefix(clean, "/"))
	if filepath.IsAbs(relativePath) || filepath.VolumeName(relativePath) != "" {
		return "", errors.New("invalid path volume")
	}
	candidate := filepath.Join(root, relativePath)
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes web root")
	}
	return resolved, nil
}

func pathSegments(value string) ([]string, error) {
	if value == "" || value == "/" || strings.HasSuffix(value, "/") {
		return nil, errors.New("invalid route")
	}
	parts := strings.Split(strings.TrimPrefix(value, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, errors.New("invalid route")
		}
	}
	return parts, nil
}

func writeBytes(writer http.ResponseWriter, request *http.Request, status int, contentType string, data []byte) {
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Content-Length", strconv.Itoa(len(data)))
	writer.WriteHeader(status)
	if request.Method != http.MethodHead {
		_, _ = writer.Write(data)
	}
}

func writeAPIFailure(writer http.ResponseWriter, request *http.Request, status int, message string) {
	payload, _ := json.Marshal(struct {
		Error string `json:"error"`
	}{Error: message})
	writer.Header().Set("Cache-Control", "no-store")
	writeBytes(writer, request, status, "application/json; charset=utf-8", payload)
}

func writeRouteFailure(writer http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	message := "本地服务暂时不可用"
	var public *routeError
	if errors.As(err, &public) {
		status = public.status
		message = public.message
	}
	log.Printf("%s %s: %v", request.Method, request.URL.Path, err)
	writeAPIFailure(writer, request, status, message)
}

func packFromQuery(request *http.Request) (string, error) {
	pack := request.URL.Query().Get("pack")
	if pack == "" {
		pack = "curated"
	}
	if pack != "curated" && pack != "33000" && pack != "55000" {
		return "", badRequest("未知画师图包")
	}
	return pack, nil
}

func (app *application) serveKoreanCatalog(writer http.ResponseWriter, request *http.Request) {
	pack, err := packFromQuery(request)
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	data, err := app.korean.catalog(pack)
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
}

func (app *application) serveKoreanStatus(writer http.ResponseWriter, request *http.Request) {
	pack, err := packFromQuery(request)
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	status := app.korean.status(request.Context(), pack, request.URL.Query().Get("check") == "1")
	data, _ := json.Marshal(status)
	writer.Header().Set("Cache-Control", "no-store")
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
}

func (app *application) serveKoreanImage(writer http.ResponseWriter, request *http.Request) {
	parts, err := pathSegments(request.URL.Path)
	if err != nil {
		writeAPIFailure(writer, request, http.StatusNotFound, "图片不存在")
		return
	}
	pack := "curated"
	var offsetText, sizeText string
	switch {
	case len(parts) == 3 && parts[0] == "korean-image":
		offsetText, sizeText = parts[1], parts[2]
	case len(parts) == 4 && parts[0] == "korean-image":
		pack, offsetText, sizeText = parts[1], parts[2], parts[3]
	default:
		writeAPIFailure(writer, request, http.StatusNotFound, "图片不存在")
		return
	}
	offset, err := strconv.ParseInt(offsetText, 10, 64)
	if err != nil || offset <= 0 {
		writeAPIFailure(writer, request, http.StatusNotFound, "图片不存在")
		return
	}
	size, err := strconv.Atoi(sizeText)
	if err != nil || size <= 0 {
		writeAPIFailure(writer, request, http.StatusNotFound, "图片不存在")
		return
	}
	if request.Method == http.MethodHead {
		if err := app.korean.authorize(pack, offset, size); err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		writer.Header().Set("Cache-Control", "private, no-store")
		writer.Header().Set("Content-Type", "application/octet-stream")
		writer.WriteHeader(http.StatusOK)
		return
	}
	data, contentType, err := app.korean.image(request.Context(), pack, offset, size)
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writeBytes(writer, request, http.StatusOK, contentType, data)
}

func (app *application) serveNAXCatalog(writer http.ResponseWriter, request *http.Request) {
	catalog, err := app.nax.catalog(request.Context(), request.URL.Query().Get("check") == "1")
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Pocket-Update", catalog.status)
	writer.Header().Set("X-Pocket-Revision", catalog.revision)
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", catalog.data)
}

func (app *application) serveNAXImage(writer http.ResponseWriter, request *http.Request) {
	parts, err := pathSegments(request.URL.Path)
	if err != nil || len(parts) != 3 || parts[0] != "nax-image" {
		writeAPIFailure(writer, request, http.StatusNotFound, "图片不存在")
		return
	}
	if request.Method == http.MethodHead {
		if err := app.nax.authorize(parts[1], parts[2]); err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		writer.Header().Set("Cache-Control", "private, no-store")
		writer.Header().Set("Content-Type", "image/webp")
		writer.WriteHeader(http.StatusOK)
		return
	}
	data, err := app.nax.image(request.Context(), parts[1], parts[2])
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writeBytes(writer, request, http.StatusOK, "image/webp", data)
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	if limit < 0 {
		return nil, errors.New("negative read limit")
	}
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errResourceTooLarge
	}
	return data, nil
}

func readCache(filename string, limit int64) ([]byte, bool) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, false
	}
	data, err := readLimited(file, limit)
	if err != nil {
		return nil, false
	}
	return data, true
}

func writeCache(filename string, data []byte) error {
	cacheWriteMu.Lock()
	defer cacheWriteMu.Unlock()

	directory := filepath.Dir(filename)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".partial-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, filename); err == nil {
		return nil
	}
	// The destination is an internal, hash-named cache entry; replacing a corrupt
	// entry is required on Windows, where Rename does not replace existing files.
	if err := os.Remove(filename); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(temporaryName, filename)
}

func pruneCache(directory, suffix string, budget int64) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	type cachedFile struct {
		name    string
		size    int64
		modTime time.Time
	}
	var files []cachedFile
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), suffix) {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, cachedFile{
			name:    filepath.Join(directory, entry.Name()),
			size:    info.Size(),
			modTime: info.ModTime(),
		})
		total += info.Size()
	}
	if total <= budget {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	for _, file := range files {
		if total <= budget {
			break
		}
		if os.Remove(file.name) == nil {
			total -= file.size
		}
	}
}

func cacheName(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = io.WriteString(hash, part)
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func imageType(data []byte) string {
	if len(data) < 12 {
		return ""
	}
	switch {
	case data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' &&
		data[4] == 0x0d && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a:
		return "image/png"
	case string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp"
	case string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a":
		return "image/gif"
	default:
		return ""
	}
}

func validHeaderCacheValue(value string, limit int) bool {
	return len(value) <= limit && !strings.ContainsAny(value, "\r\n\x00")
}

func safeRedirectTarget(current *url.URL, location string) (*url.URL, error) {
	if location == "" || len(location) > 4096 || strings.ContainsAny(location, "\r\n\x00") {
		return nil, errors.New("invalid redirect")
	}
	reference, err := url.Parse(location)
	if err != nil {
		return nil, err
	}
	return current.ResolveReference(reference), nil
}

func fatal(format string, arguments ...any) {
	message := fmt.Sprintf(format, arguments...)
	log.Print(message)
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("NAI 口袋词库")
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	_, _, _ = messageBox.Call(0, uintptr(unsafe.Pointer(title)), uintptr(unsafe.Pointer(text)), 0x10)
	os.Exit(1)
}
