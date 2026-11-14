//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"
)

const (
	desktopDictionarySourceURL = "https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/" +
		"releases/download/v2026-11-01/tag.sqlite"
	desktopDictionaryRepository = "https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table"
	desktopDictionaryVersion    = "v2026-11-01"
	desktopDictionarySHA256     = "48523aaf9ac800e13a72c7d68ce78021e6d55c811891719ade0820c6c536b716"
	desktopDictionaryBytes      = int64(24829952)
	desktopDictionaryLicense    = "MIT"

	desktopDictionaryLookupLimit      = 200
	desktopDictionaryNameRuneLimit    = 512
	desktopDictionaryLookupBodyLimit  = int64(1024 * 1024)
	desktopDictionaryColumnBytesLimit = 64 * 1024
	desktopDictionaryMaxRedirects     = 5
	desktopDictionaryDownloadTimeout  = 5 * time.Minute
)

const (
	desktopDictionaryStatusRoute  = "/api/tag-dictionary/status"
	desktopDictionaryInstallRoute = "/api/tag-dictionary/install"
	desktopDictionaryRemoveRoute  = "/api/tag-dictionary/remove"
	desktopDictionaryLookupRoute  = "/api/tag-dictionary/lookup"
)

var desktopDictionaryAssetHosts = map[string]bool{
	"release-assets.githubusercontent.com": true,
	"objects.githubusercontent.com":        true,
}

type desktopDictionary struct {
	directory string
	database  string

	expectedBytes  int64
	expectedSHA256 string

	// operation serializes install and removal. Lookups deliberately do not use
	// this lock, so an installed dictionary remains usable during a download.
	operation sync.Mutex

	// dbMu protects validation state and every open SQLite handle. It is held
	// only for local file/schema work and never while downloading.
	dbMu           sync.Mutex
	validatedTable string
	validatedBytes int64
	validatedMod   time.Time

	// downloadForTest lets tests stage a local synthetic database without
	// opening a network connection.
	downloadForTest func(context.Context, string) error
}

type desktopDictionaryStatus struct {
	Installed     bool   `json:"installed"`
	Bytes         int64  `json:"bytes"`
	ExpectedBytes int64  `json:"expectedBytes"`
	Version       string `json:"version"`
	SHA256        string `json:"sha256"`
	Source        string `json:"source"`
	Repository    string `json:"repository"`
	License       string `json:"license"`
}

func newDesktopDictionary(cacheRoot string) *desktopDictionary {
	directory := filepath.Join(cacheRoot, "tag-dictionary")
	return &desktopDictionary{
		directory:      directory,
		database:       filepath.Join(directory, "tag.sqlite"),
		expectedBytes:  desktopDictionaryBytes,
		expectedSHA256: desktopDictionarySHA256,
	}
}

func (d *desktopDictionary) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	switch request.URL.Path {
	case desktopDictionaryStatusRoute:
		if !desktopDictionaryMethod(writer, request, http.MethodGet, http.MethodHead) {
			return
		}
		status, err := d.status()
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		data, err := json.Marshal(status)
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
	case desktopDictionaryInstallRoute:
		if !desktopDictionaryMethod(writer, request, http.MethodPost) {
			return
		}
		status, err := d.install(request.Context())
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		desktopDictionaryWriteStatus(writer, request, status)
	case desktopDictionaryRemoveRoute:
		if !desktopDictionaryMethod(writer, request, http.MethodPost) {
			return
		}
		if err := d.remove(); err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		status, err := d.status()
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		desktopDictionaryWriteStatus(writer, request, status)
	case desktopDictionaryLookupRoute:
		if !desktopDictionaryMethod(writer, request, http.MethodPost) {
			return
		}
		result, err := d.lookupRequest(writer, request)
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		desktopDictionaryWriteJSON(writer, request, result)
	default:
		writeRouteFailure(writer, request, notFound("接口不存在"))
	}
}

func desktopDictionaryMethod(writer http.ResponseWriter, request *http.Request, methods ...string) bool {
	for _, method := range methods {
		if request.Method == method {
			return true
		}
	}
	writer.Header().Set("Allow", strings.Join(methods, ", "))
	writeAPIFailure(writer, request, http.StatusMethodNotAllowed, "请求方法不受支持")
	return false
}

func desktopDictionaryWriteStatus(writer http.ResponseWriter, request *http.Request, status desktopDictionaryStatus) {
	data, err := json.Marshal(status)
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	desktopDictionaryWriteJSON(writer, request, data)
}

func desktopDictionaryWriteJSON(writer http.ResponseWriter, request *http.Request, data []byte) {
	writer.Header().Set("Cache-Control", "no-store")
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
}

func desktopDictionaryPublicError(message string, cause error) error {
	if cause == nil {
		return unavailable(message)
	}
	return fmt.Errorf("%w: %v", unavailable(message), cause)
}

func desktopDictionaryBusy() error {
	return &routeError{status: http.StatusConflict, message: "中文标签词典正在下载或卸载，请稍候。"}
}

func (d *desktopDictionary) status() (desktopDictionaryStatus, error) {
	d.dbMu.Lock()
	defer d.dbMu.Unlock()

	status := desktopDictionaryStatus{
		ExpectedBytes: d.expectedBytes,
		Version:       desktopDictionaryVersion,
		SHA256:        d.expectedSHA256,
		Source:        desktopDictionarySourceURL,
		Repository:    desktopDictionaryRepository,
		License:       desktopDictionaryLicense,
	}
	info, err := os.Stat(d.database)
	if errors.Is(err, os.ErrNotExist) {
		return status, nil
	}
	if err != nil {
		return status, desktopDictionaryPublicError("无法读取中文标签词典安装状态。", err)
	}
	status.Bytes = info.Size()
	if !info.Mode().IsRegular() || info.Size() != d.expectedBytes {
		d.forgetValidationLocked()
		return status, nil
	}
	table, err := d.validatedTableLocked(info)
	if err != nil {
		d.forgetValidationLocked()
		return status, nil
	}
	status.Installed = table != ""
	return status, nil
}

func (d *desktopDictionary) install(ctx context.Context) (desktopDictionaryStatus, error) {
	if !d.operation.TryLock() {
		return desktopDictionaryStatus{}, desktopDictionaryBusy()
	}
	defer d.operation.Unlock()

	if status, err := d.status(); err != nil || status.Installed {
		return status, err
	}
	if err := os.MkdirAll(d.directory, 0o700); err != nil {
		return desktopDictionaryStatus{}, desktopDictionaryPublicError("无法创建中文标签词典目录。", err)
	}
	temporary, err := os.CreateTemp(d.directory, ".tag.sqlite.download-*")
	if err != nil {
		return desktopDictionaryStatus{}, desktopDictionaryPublicError("无法创建中文标签词典临时文件。", err)
	}
	temporaryName := temporary.Name()
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		os.Remove(temporaryName)
		return desktopDictionaryStatus{}, desktopDictionaryPublicError("无法保护中文标签词典临时文件。", err)
	}
	if err := temporary.Close(); err != nil {
		os.Remove(temporaryName)
		return desktopDictionaryStatus{}, desktopDictionaryPublicError("无法准备中文标签词典临时文件。", err)
	}
	defer os.Remove(temporaryName)

	if d.downloadForTest != nil {
		err = d.downloadForTest(ctx, temporaryName)
	} else {
		err = d.download(ctx, temporaryName)
	}
	if err != nil {
		return desktopDictionaryStatus{}, desktopDictionaryPublicError("中文标签词典下载失败，未安装。", err)
	}
	table, err := d.validateDownload(temporaryName)
	if err != nil {
		return desktopDictionaryStatus{}, desktopDictionaryPublicError("中文标签词典校验失败，未安装。", err)
	}

	d.dbMu.Lock()
	err = os.Rename(temporaryName, d.database)
	if err == nil {
		d.rememberValidationLocked(table)
	}
	d.dbMu.Unlock()
	if err != nil {
		return desktopDictionaryStatus{}, desktopDictionaryPublicError("无法提交已校验的中文标签词典。", err)
	}
	return d.status()
}

func (d *desktopDictionary) remove() error {
	if !d.operation.TryLock() {
		return desktopDictionaryBusy()
	}
	defer d.operation.Unlock()

	d.dbMu.Lock()
	defer d.dbMu.Unlock()
	if err := os.Remove(d.database); err != nil && !errors.Is(err, os.ErrNotExist) {
		return desktopDictionaryPublicError("无法卸载中文标签词典。", err)
	}
	d.forgetValidationLocked()
	return nil
}

func (d *desktopDictionary) lookupRequest(writer http.ResponseWriter, request *http.Request) ([]byte, error) {
	request.Body = http.MaxBytesReader(writer, request.Body, desktopDictionaryLookupBodyLimit)
	defer request.Body.Close()
	decoder := json.NewDecoder(request.Body)
	var values []string
	if err := decoder.Decode(&values); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, &routeError{status: http.StatusRequestEntityTooLarge, message: "词典查询请求过大。"}
		}
		return nil, badRequest("词典查询请求必须是字符串数组。")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, badRequest("词典查询请求只能包含一个 JSON 数组。")
	}
	if len(values) > desktopDictionaryLookupLimit {
		return nil, badRequest("单次词典查询最多 200 个标签。")
	}
	names := make([]string, 0, len(values))
	for _, value := range values {
		name := strings.TrimSpace(value)
		if name == "" {
			continue
		}
		if utf8.RuneCountInString(name) > desktopDictionaryNameRuneLimit {
			return nil, badRequest("单个标签不能超过 512 个字符。")
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return []byte("{}"), nil
	}
	result, err := d.lookup(names)
	if err != nil {
		return nil, err
	}
	return json.Marshal(result)
}

func (d *desktopDictionary) lookup(names []string) (map[string]string, error) {
	result := make(map[string]string)
	d.dbMu.Lock()
	defer d.dbMu.Unlock()

	info, err := os.Stat(d.database)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return nil, desktopDictionaryPublicError("无法读取中文标签词典。", err)
	}
	if !info.Mode().IsRegular() || info.Size() != d.expectedBytes {
		d.forgetValidationLocked()
		return result, nil
	}
	table, err := d.validatedTableLocked(info)
	if err != nil || table == "" {
		d.forgetValidationLocked()
		return result, nil
	}

	database, err := openDesktopSQLite(d.database, desktopSQLiteReadOnly)
	if err != nil {
		return nil, desktopDictionaryPublicError("无法打开中文标签词典。", err)
	}
	defer database.close()
	statement, err := database.prepare(
		`SELECT cn_name FROM "` + table + `" WHERE name = ? COLLATE BINARY LIMIT 1`,
	)
	if err != nil {
		return nil, desktopDictionaryPublicError("无法查询中文标签词典。", err)
	}
	defer statement.close()

	for _, name := range names {
		if err := statement.reset(); err != nil {
			return nil, desktopDictionaryPublicError("无法准备中文标签词典查询。", err)
		}
		if err := statement.bindText(1, name); err != nil {
			return nil, desktopDictionaryPublicError("无法绑定中文标签词典查询。", err)
		}
		row, err := statement.step()
		if err != nil {
			return nil, desktopDictionaryPublicError("无法执行中文标签词典查询。", err)
		}
		if !row {
			continue
		}
		translation, err := statement.columnText(0)
		if err != nil {
			return nil, desktopDictionaryPublicError("无法读取中文标签词典译文。", err)
		}
		translation = strings.TrimSpace(translation)
		if translation != "" {
			result[name] = translation
		}
	}
	return result, nil
}

func (d *desktopDictionary) validatedTableLocked(info os.FileInfo) (string, error) {
	if d.validatedTable != "" &&
		d.validatedBytes == info.Size() &&
		d.validatedMod.Equal(info.ModTime()) {
		return d.validatedTable, nil
	}
	table, err := d.validateDownload(d.database)
	if err != nil {
		return "", err
	}
	d.rememberValidationLocked(table)
	return table, nil
}

func (d *desktopDictionary) rememberValidationLocked(table string) {
	info, err := os.Stat(d.database)
	if err != nil || !info.Mode().IsRegular() {
		d.forgetValidationLocked()
		return
	}
	d.validatedTable = table
	d.validatedBytes = info.Size()
	d.validatedMod = info.ModTime()
}

func (d *desktopDictionary) forgetValidationLocked() {
	d.validatedTable = ""
	d.validatedBytes = 0
	d.validatedMod = time.Time{}
}

func (d *desktopDictionary) validateDownload(filename string) (string, error) {
	info, err := os.Stat(filename)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() != d.expectedBytes {
		return "", errors.New("词典文件大小与发行信息不一致")
	}
	digest, err := desktopDictionaryFileSHA256(filename)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(digest, d.expectedSHA256) {
		return "", errors.New("词典 SHA-256 与发行信息不一致")
	}
	return desktopDictionaryTable(filename)
}

func (d *desktopDictionary) download(ctx context.Context, destination string) error {
	parsed, err := url.Parse(desktopDictionarySourceURL)
	if err != nil || parsed.String() != desktopDictionarySourceURL {
		return errors.New("中文标签词典下载地址无效")
	}
	deadline, cancel := context.WithTimeout(ctx, desktopDictionaryDownloadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(deadline, http.MethodGet, desktopDictionarySourceURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "NAI-Pocket-Library-Tag-Dictionary")

	transport := &http.Transport{
		Proxy:                 desktopUpstreamProxy,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          2,
		MaxIdleConnsPerHost:   2,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   desktopDictionaryDownloadTimeout,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) > desktopDictionaryMaxRedirects {
				return errors.New("中文标签词典下载重定向次数过多")
			}
			if !desktopDictionaryAllowedAssetURL(next.URL) {
				return errors.New("中文标签词典下载被重定向到非官方 HTTPS 地址")
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return communityReadError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("中文标签词典下载返回 HTTP %d", response.StatusCode)
	}
	if response.ContentLength >= 0 && response.ContentLength != d.expectedBytes {
		return errors.New("中文标签词典下载大小与发行信息不一致")
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" &&
		!strings.EqualFold(encoding, "identity") {
		return errors.New("中文标签词典下载使用了不支持的传输编码")
	}

	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	var total int64
	buffer := make([]byte, 64*1024)
	for {
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			total += int64(read)
			if total > d.expectedBytes {
				file.Close()
				return errors.New("中文标签词典下载超过发行大小")
			}
			if _, err := file.Write(buffer[:read]); err != nil {
				file.Close()
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			file.Close()
			return readErr
		}
	}
	if total != d.expectedBytes {
		file.Close()
		return errors.New("中文标签词典下载不完整")
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func desktopDictionaryAllowedAssetURL(target *url.URL) bool {
	if target == nil ||
		!strings.EqualFold(target.Scheme, "https") ||
		target.User != nil ||
		(target.Port() != "" && target.Port() != "443") {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(target.Hostname(), "."))
	return desktopDictionaryAssetHosts[host]
}

func desktopDictionaryFileSHA256(filename string) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func desktopDictionaryTable(filename string) (string, error) {
	database, err := openDesktopSQLite(filename, desktopSQLiteReadOnly)
	if err != nil {
		return "", err
	}
	defer database.close()

	for _, table := range []string{"tags", "tag"} {
		exists, err := database.tableExists(table)
		if err != nil {
			return "", err
		}
		if !exists {
			continue
		}
		if err := database.validateColumns(table); err != nil {
			return "", err
		}
		return table, nil
	}
	return "", errors.New("中文标签词典缺少 tag 或 tags 表")
}

const (
	desktopSQLiteOK       = 0
	desktopSQLiteRow      = 100
	desktopSQLiteDone     = 101
	desktopSQLiteReadOnly = 0x00000001
)

type desktopSQLiteAPI struct {
	openV2      *syscall.LazyProc
	closeV2     *syscall.LazyProc
	errmsg      *syscall.LazyProc
	prepareV2   *syscall.LazyProc
	finalize    *syscall.LazyProc
	step        *syscall.LazyProc
	reset       *syscall.LazyProc
	clearBinds  *syscall.LazyProc
	bindText    *syscall.LazyProc
	columnText  *syscall.LazyProc
	columnBytes *syscall.LazyProc
}

var (
	desktopSQLiteOnce sync.Once
	desktopSQLite     *desktopSQLiteAPI
	desktopSQLiteErr  error
)

func desktopSQLiteProcedures() (*desktopSQLiteAPI, error) {
	desktopSQLiteOnce.Do(func() {
		var directory [syscall.MAX_PATH]uint16
		getSystemDirectory := syscall.NewLazyDLL("kernel32.dll").NewProc("GetSystemDirectoryW")
		length, _, err := getSystemDirectory.Call(uintptr(unsafe.Pointer(&directory[0])), uintptr(len(directory)))
		if length == 0 || length >= uintptr(len(directory)) {
			desktopSQLiteErr = fmt.Errorf("无法确定 Windows System32 目录: %w", err)
			return
		}
		filename := filepath.Join(syscall.UTF16ToString(directory[:length]), "winsqlite3.dll")
		info, err := os.Stat(filename)
		if err != nil {
			desktopSQLiteErr = fmt.Errorf("无法读取 %s: %w", filename, err)
			return
		}
		if !info.Mode().IsRegular() {
			desktopSQLiteErr = fmt.Errorf("%s 不是普通文件", filename)
			return
		}
		library := syscall.NewLazyDLL(filename)
		if err := library.Load(); err != nil {
			desktopSQLiteErr = fmt.Errorf("无法加载 %s: %w", filename, err)
			return
		}
		api := &desktopSQLiteAPI{
			openV2:      library.NewProc("sqlite3_open_v2"),
			closeV2:     library.NewProc("sqlite3_close_v2"),
			errmsg:      library.NewProc("sqlite3_errmsg"),
			prepareV2:   library.NewProc("sqlite3_prepare_v2"),
			finalize:    library.NewProc("sqlite3_finalize"),
			step:        library.NewProc("sqlite3_step"),
			reset:       library.NewProc("sqlite3_reset"),
			clearBinds:  library.NewProc("sqlite3_clear_bindings"),
			bindText:    library.NewProc("sqlite3_bind_text"),
			columnText:  library.NewProc("sqlite3_column_text"),
			columnBytes: library.NewProc("sqlite3_column_bytes"),
		}
		for _, procedure := range []*syscall.LazyProc{
			api.openV2, api.closeV2, api.errmsg, api.prepareV2, api.finalize,
			api.step, api.reset, api.clearBinds, api.bindText, api.columnText, api.columnBytes,
		} {
			if err := procedure.Find(); err != nil {
				desktopSQLiteErr = fmt.Errorf("winsqlite3.dll 缺少预期函数: %w", err)
				return
			}
		}
		desktopSQLite = api
	})
	return desktopSQLite, desktopSQLiteErr
}

type desktopSQLiteDatabase struct {
	api    *desktopSQLiteAPI
	handle uintptr
}

type desktopSQLiteStatement struct {
	api    *desktopSQLiteAPI
	handle uintptr
}

func openDesktopSQLite(filename string, flags uintptr) (*desktopSQLiteDatabase, error) {
	api, err := desktopSQLiteProcedures()
	if err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(filename)
	if err != nil {
		return nil, err
	}
	if strings.IndexByte(absolute, 0) >= 0 {
		return nil, errors.New("SQLite 文件路径包含空字符")
	}
	pathBytes := append([]byte(absolute), 0)
	var handle uintptr
	code, _, _ := api.openV2.Call(
		uintptr(unsafe.Pointer(&pathBytes[0])),
		uintptr(unsafe.Pointer(&handle)),
		flags,
		0,
	)
	runtime.KeepAlive(pathBytes)
	if code != desktopSQLiteOK {
		message := desktopSQLiteErrorMessage(api, handle)
		if handle != 0 {
			api.closeV2.Call(handle)
		}
		return nil, fmt.Errorf("SQLite 无法打开词典（%d）：%s", code, message)
	}
	if handle == 0 {
		return nil, errors.New("SQLite 返回了空数据库句柄")
	}
	return &desktopSQLiteDatabase{api: api, handle: handle}, nil
}

func (database *desktopSQLiteDatabase) close() {
	if database != nil && database.handle != 0 {
		database.api.closeV2.Call(database.handle)
		database.handle = 0
	}
}

func (database *desktopSQLiteDatabase) prepare(query string) (*desktopSQLiteStatement, error) {
	if strings.IndexByte(query, 0) >= 0 {
		return nil, errors.New("SQLite 查询包含空字符")
	}
	queryBytes := append([]byte(query), 0)
	var handle uintptr
	code, _, _ := database.api.prepareV2.Call(
		database.handle,
		uintptr(unsafe.Pointer(&queryBytes[0])),
		uintptr(len(queryBytes)),
		uintptr(unsafe.Pointer(&handle)),
		0,
	)
	runtime.KeepAlive(queryBytes)
	if code != desktopSQLiteOK {
		return nil, fmt.Errorf("SQLite 查询准备失败（%d）：%s",
			code, desktopSQLiteErrorMessage(database.api, database.handle))
	}
	if handle == 0 {
		return nil, errors.New("SQLite 返回了空查询句柄")
	}
	return &desktopSQLiteStatement{api: database.api, handle: handle}, nil
}

func (statement *desktopSQLiteStatement) close() {
	if statement != nil && statement.handle != 0 {
		statement.api.finalize.Call(statement.handle)
		statement.handle = 0
	}
}

func (statement *desktopSQLiteStatement) reset() error {
	statement.api.clearBinds.Call(statement.handle)
	code, _, _ := statement.api.reset.Call(statement.handle)
	if code != desktopSQLiteOK {
		return fmt.Errorf("SQLite reset failed (%d)", code)
	}
	return nil
}

func (statement *desktopSQLiteStatement) bindText(index int, value string) error {
	data := append([]byte(value), 0)
	const sqliteTransient = ^uintptr(0)
	code, _, _ := statement.api.bindText.Call(
		statement.handle,
		uintptr(index),
		uintptr(unsafe.Pointer(&data[0])),
		uintptr(len(value)),
		sqliteTransient,
	)
	runtime.KeepAlive(data)
	if code != desktopSQLiteOK {
		return fmt.Errorf("SQLite bind failed (%d)", code)
	}
	return nil
}

func (statement *desktopSQLiteStatement) step() (bool, error) {
	code, _, _ := statement.api.step.Call(statement.handle)
	switch code {
	case desktopSQLiteRow:
		return true, nil
	case desktopSQLiteDone:
		return false, nil
	default:
		return false, fmt.Errorf("SQLite step failed (%d)", code)
	}
}

func (statement *desktopSQLiteStatement) columnText(index int) (string, error) {
	pointer, _, _ := statement.api.columnText.Call(statement.handle, uintptr(index))
	if pointer == 0 {
		return "", nil
	}
	length, _, _ := statement.api.columnBytes.Call(statement.handle, uintptr(index))
	if length > desktopDictionaryColumnBytesLimit {
		return "", errors.New("SQLite 文本字段超过安全长度")
	}
	if length == 0 {
		return "", nil
	}
	value := desktopSQLiteByteSlice(pointer, int(length))
	return string(value), nil
}

func (database *desktopSQLiteDatabase) tableExists(table string) (bool, error) {
	statement, err := database.prepare(
		"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
	)
	if err != nil {
		return false, err
	}
	defer statement.close()
	if err := statement.bindText(1, table); err != nil {
		return false, err
	}
	return statement.step()
}

func (database *desktopSQLiteDatabase) validateColumns(table string) error {
	statement, err := database.prepare(`PRAGMA table_info("` + table + `")`)
	if err != nil {
		return err
	}
	hasName, hasChinese := false, false
	for {
		row, err := statement.step()
		if err != nil {
			statement.close()
			return err
		}
		if !row {
			break
		}
		column, err := statement.columnText(1)
		if err != nil {
			statement.close()
			return err
		}
		switch column {
		case "name":
			hasName = true
		case "cn_name":
			hasChinese = true
		}
	}
	statement.close()
	if !hasName || !hasChinese {
		return errors.New("中文标签词典缺少 name 或 cn_name 字段")
	}
	return nil
}

func desktopSQLiteErrorMessage(api *desktopSQLiteAPI, handle uintptr) string {
	if api == nil || handle == 0 {
		return "未知 SQLite 错误"
	}
	pointer, _, _ := api.errmsg.Call(handle)
	if pointer == 0 {
		return "未知 SQLite 错误"
	}
	const maxMessageBytes = 4096
	message := make([]byte, 0, 128)
	for offset := uintptr(0); offset < maxMessageBytes; offset++ {
		if pointer > ^uintptr(0)-offset {
			break
		}
		value := *desktopSQLiteBytePointer(pointer + offset)
		if value == 0 {
			break
		}
		message = append(message, value)
	}
	if len(message) == 0 {
		return "未知 SQLite 错误"
	}
	return string(message)
}

// The winsqlite3 API returns C-owned memory. Both helpers are called only
// immediately after sqlite3_column_* or sqlite3_errmsg, before another call can
// invalidate that memory, and every conversion is bounded by the caller.
//
//go:nocheckptr
func desktopSQLiteBytePointer(pointer uintptr) *byte {
	return (*byte)(unsafe.Pointer(pointer))
}

func desktopSQLiteByteSlice(pointer uintptr, length int) []byte {
	if pointer == 0 {
		return nil
	}
	if length < 0 || length > desktopDictionaryColumnBytesLimit {
		return nil
	}
	if uintptr(length) > ^uintptr(0)-pointer {
		return nil
	}
	return unsafe.Slice(desktopSQLiteBytePointer(pointer), length)
}
