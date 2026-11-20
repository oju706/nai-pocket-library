package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	windowsReleaseBase = "https://raw.githubusercontent.com/oju706/nai-pocket-library/main/release/"
	windowsUpdateFile  = "NAI-Pocket-Library-Windows-x64.zip"
	windowsBundleRoot  = "NAI-Pocket-Library/"
	windowsUpdateEXE   = "NAI-Pocket-Library.exe"
	windowsUpdateLimit = 128 << 20
)

var windowsUpdateFiles = map[string]bool{
	windowsUpdateEXE: true,
	"README.md":      false, "ffdkj-MIT.txt": false,
	"web/index.html": true, "web/app.js": true, "web/style.css": true,
	"web/tag-gallery.js": true, "web/tag-gallery.css": true,
	"web/gallery.js": true, "web/gallery.css": true,
	"web/online-pack.js": true, "web/online-pack.css": true,
	"web/sources.js": true, "web/core-state.js": true, "web/chain-workbench.js": true, "web/image-parser.js": true,
	"web/korean-index.json": true, "web/korean-33000-index.json": true,
	"web/korean-55000-index.json": true, "web/community-style-models.json": true,
}

type windowsUpdateManifest struct {
	App     string `json:"app"`
	Version string `json:"version"`
	File    string `json:"file"`
	Bytes   int64  `json:"bytes"`
	SHA256  string `json:"sha256"`
	Notes   string `json:"notes"`
}

type windowsUpdateStatus struct {
	CurrentVersion string `json:"currentVersion"`
	Version        string `json:"version"`
	Available      bool   `json:"available"`
	Ready          bool   `json:"ready"`
	Notes          string `json:"notes"`
	Message        string `json:"message,omitempty"`
}

type windowsUpdateActivation struct {
	Manifest windowsUpdateManifest `json:"manifest"`
	Package  string                `json:"package"`
	Hashes   map[string]string     `json:"hashes"`
}

type windowsUpdater struct {
	directory string
	client    *http.Client
	operation sync.Mutex
}

func newWindowsUpdater(cacheRoot string) *windowsUpdater {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = desktopUpstreamProxy
	transport.ResponseHeaderTimeout = 20 * time.Second
	return &windowsUpdater{
		directory: filepath.Join(cacheRoot, "desktop-update"),
		client: &http.Client{Transport: transport, Timeout: 2 * time.Minute,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

func (updater *windowsUpdater) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !updater.operation.TryLock() {
		writeAPIFailure(writer, request, http.StatusConflict, "应用更新正在进行，请稍后重试。")
		return
	}
	defer updater.operation.Unlock()

	status, err := updater.update(request.Context(), request.URL.Path == "/api/windows-update/download")
	if err != nil {
		writeAPIFailure(writer, request, http.StatusBadGateway, err.Error())
		return
	}
	encoded, _ := json.Marshal(status)
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", encoded)
}

func (updater *windowsUpdater) update(ctx context.Context, download bool) (windowsUpdateStatus, error) {
	status := windowsUpdateStatus{CurrentVersion: appVersion, Version: appVersion}
	active, ready := updater.readActivation()
	if ready {
		status.Version, status.Notes = active.Manifest.Version, active.Manifest.Notes
		status.Available, status.Ready = true, true
	}
	manifest, found, err := updater.fetchManifest(ctx)
	if err != nil {
		if ready {
			return status, nil
		}
		return status, err
	}
	if !found {
		status.Message = "发布仓库尚无 Windows 自动更新清单。"
		return status, nil
	}
	if !newerWindowsVersion(manifest.Version, status.Version) {
		return status, nil
	}
	status.Version, status.Notes = manifest.Version, manifest.Notes
	status.Available, status.Ready = true, false
	if download {
		if err := updater.stage(ctx, manifest); err != nil {
			return status, err
		}
		status.Ready = true
	}
	return status, nil
}

func (updater *windowsUpdater) fetchManifest(ctx context.Context) (windowsUpdateManifest, bool, error) {
	var manifest windowsUpdateManifest
	response, err := updater.get(ctx, "desktop-update.json")
	if err != nil {
		return manifest, false, errors.New("暂时无法连接 Windows 发布仓库。")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return manifest, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return manifest, false, errors.New("发布仓库暂时无法提供 Windows 更新清单。")
	}
	data, err := readLimited(response.Body, 32<<10)
	if err != nil || decodeWindowsUpdateJSON(data, &manifest) != nil || !validWindowsUpdateManifest(manifest) {
		return manifest, false, errors.New("Windows 更新清单校验失败。")
	}
	return manifest, true, nil
}

func (updater *windowsUpdater) get(ctx context.Context, name string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, windowsReleaseBase+name, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept-Encoding", "identity")
	return updater.client.Do(request)
}

func decodeWindowsUpdateJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("unexpected trailing data")
	}
	return nil
}

func validWindowsUpdateManifest(manifest windowsUpdateManifest) bool {
	_, validVersion := windowsVersionParts(manifest.Version)
	return validVersion && manifest.App == appID && manifest.File == windowsUpdateFile &&
		manifest.Bytes > 0 && manifest.Bytes <= windowsUpdateLimit && len(manifest.Notes) <= 16<<10 &&
		validWindowsUpdateHash(manifest.SHA256)
}

func validWindowsUpdateHash(digest string) bool {
	if len(digest) != sha256.Size*2 || strings.ToLower(digest) != digest {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}

func windowsVersionParts(version string) ([3]int, bool) {
	var numbers [3]int
	parts := strings.Split(version, ".")
	if len(parts) != len(numbers) {
		return numbers, false
	}
	for i, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || len(part) > 9 || number < 0 || strconv.Itoa(number) != part {
			return numbers, false
		}
		numbers[i] = number
	}
	return numbers, true
}

func newerWindowsVersion(next, current string) bool {
	a, nextValid := windowsVersionParts(next)
	b, currentValid := windowsVersionParts(current)
	if !nextValid || !currentValid {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func (updater *windowsUpdater) stage(ctx context.Context, manifest windowsUpdateManifest) error {
	versionRoot := filepath.Join(updater.directory, "versions", manifest.Version)
	if err := os.MkdirAll(versionRoot, 0o700); err != nil {
		return errors.New("无法创建 Windows 更新缓存。")
	}
	packageRoot, err := os.MkdirTemp(versionRoot, "package-")
	if err != nil {
		return errors.New("无法创建 Windows 更新的临时目录。")
	}
	activated := false
	defer func() {
		if !activated {
			_ = os.RemoveAll(packageRoot)
		}
	}()

	archivePath := filepath.Join(packageRoot, "download.zip")
	if err := updater.download(ctx, manifest, archivePath); err != nil {
		return err
	}
	hashes, err := extractWindowsUpdate(archivePath, packageRoot)
	if err != nil || !windowsUpdateIsEXE(filepath.Join(packageRoot, windowsUpdateEXE)) {
		return errors.New("Windows ZIP 无法通过安装文件校验。")
	}
	if err := os.Remove(archivePath); err != nil {
		return errors.New("无法完成 Windows ZIP 解包。")
	}
	if err := ctx.Err(); err != nil {
		return errors.New("Windows 更新已取消。")
	}
	activation := windowsUpdateActivation{Manifest: manifest, Package: filepath.Base(packageRoot), Hashes: hashes}
	encoded, _ := json.Marshal(activation)
	if err := writeWindowsActivation(filepath.Join(updater.directory, "active.json"), encoded); err != nil {
		return errors.New("无法保存 Windows 更新状态。")
	}
	activated = true
	return nil
}

func (updater *windowsUpdater) download(ctx context.Context, manifest windowsUpdateManifest, destination string) error {
	response, err := updater.get(ctx, windowsUpdateFile)
	if err != nil {
		return errors.New("Windows 新版下载失败，请重试。")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength >= 0 && response.ContentLength != manifest.Bytes {
		return errors.New("Windows ZIP 大小与更新清单不一致。")
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("无法保存 Windows ZIP。")
	}
	digest := sha256.New()
	length, err := io.Copy(io.MultiWriter(file, digest), io.LimitReader(response.Body, manifest.Bytes+1))
	closeErr := file.Close()
	if err != nil || closeErr != nil || length != manifest.Bytes || hex.EncodeToString(digest.Sum(nil)) != manifest.SHA256 {
		return errors.New("Windows ZIP 的长度或 SHA-256 校验失败，已保留当前版本。")
	}
	return nil
}

func extractWindowsUpdate(archivePath, destination string) (map[string]string, error) {
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	if len(archive.File) > len(windowsUpdateFiles)+2 {
		return nil, errors.New("too many ZIP entries")
	}
	hashes := make(map[string]string, len(windowsUpdateFiles))
	seen := make(map[string]bool, len(archive.File))
	var total uint64
	for _, entry := range archive.File {
		if seen[entry.Name] {
			return nil, errors.New("duplicate ZIP entry")
		}
		seen[entry.Name] = true
		if entry.Mode().IsDir() && (entry.Name == windowsBundleRoot || entry.Name == windowsBundleRoot+"web/") {
			continue
		}
		name := strings.TrimPrefix(entry.Name, windowsBundleRoot)
		if _, allowed := windowsUpdateFiles[name]; !allowed || name == entry.Name || !entry.Mode().IsRegular() ||
			entry.ExternalAttrs&0x410 != 0 || entry.UncompressedSize64 == 0 || entry.UncompressedSize64 > windowsUpdateLimit-total {
			return nil, errors.New("invalid ZIP entry")
		}
		total += entry.UncompressedSize64
		hash, err := extractWindowsUpdateFile(entry, filepath.Join(destination, filepath.FromSlash(name)))
		if err != nil {
			return nil, err
		}
		hashes[name] = hash
	}
	for name, required := range windowsUpdateFiles {
		if required && hashes[name] == "" {
			return nil, errors.New("incomplete ZIP")
		}
	}
	return hashes, nil
}

func extractWindowsUpdateFile(entry *zip.File, target string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	input, err := entry.Open()
	if err != nil {
		return "", err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	limit := int64(entry.UncompressedSize64)
	length, err := io.Copy(io.MultiWriter(output, digest), io.LimitReader(input, limit+1))
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err != nil || closeErr != nil || length != limit {
		return "", errors.New("incorrect ZIP entry length or checksum")
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func writeWindowsActivation(target string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(target), ".activation-")
	if err != nil {
		return err
	}
	source := file.Name()
	defer os.Remove(source)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	from, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	move := syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")
	const replaceExistingAndWriteThrough = 0x1 | 0x8
	if result, _, callErr := move.Call(uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(to)), replaceExistingAndWriteThrough); result == 0 {
		return callErr
	}
	return nil
}

func (updater *windowsUpdater) activeExecutable() string {
	activation, ok := updater.readActivation()
	if !ok {
		return ""
	}
	return filepath.Join(updater.packageRoot(activation), windowsUpdateEXE)
}

func (updater *windowsUpdater) packageRoot(activation windowsUpdateActivation) string {
	return filepath.Join(updater.directory, "versions", activation.Manifest.Version, activation.Package)
}

func (updater *windowsUpdater) readActivation() (windowsUpdateActivation, bool) {
	var activation windowsUpdateActivation
	data, ok := readCache(filepath.Join(updater.directory, "active.json"), 48<<10)
	if !ok || decodeWindowsUpdateJSON(data, &activation) != nil || !validWindowsUpdateManifest(activation.Manifest) ||
		!newerWindowsVersion(activation.Manifest.Version, appVersion) || !strings.HasPrefix(activation.Package, "package-") {
		return activation, false
	}
	packageSuffix := strings.TrimPrefix(activation.Package, "package-")
	if _, err := strconv.ParseUint(packageSuffix, 10, 32); err != nil {
		return activation, false
	}
	root := updater.packageRoot(activation)
	web := filepath.Join(root, "web")
	for _, dir := range []string{filepath.Dir(root), root, web} {
		if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return activation, false
		}
	}
	for name, required := range windowsUpdateFiles {
		digest, present := activation.Hashes[name]
		if !present && !required {
			continue
		}
		if !validWindowsUpdateHash(digest) || !windowsUpdateFileMatches(filepath.Join(root, filepath.FromSlash(name)), digest) {
			return activation, false
		}
	}
	return activation, windowsUpdateIsEXE(filepath.Join(root, windowsUpdateEXE))
}

func windowsUpdateFileMatches(name, expected string) bool {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > windowsUpdateLimit {
		return false
	}
	file, err := os.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	digest := sha256.New()
	length, err := io.Copy(digest, io.LimitReader(file, info.Size()+1))
	return err == nil && length == info.Size() && hex.EncodeToString(digest.Sum(nil)) == expected
}

func windowsUpdateIsEXE(name string) bool {
	file, err := os.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	var dos [64]byte
	if _, err := io.ReadFull(file, dos[:]); err != nil || string(dos[:2]) != "MZ" {
		return false
	}
	var pe [6]byte
	if _, err := file.ReadAt(pe[:], int64(binary.LittleEndian.Uint32(dos[60:]))); err != nil {
		return false
	}
	return string(pe[:4]) == "PE\x00\x00" && binary.LittleEndian.Uint16(pe[4:]) == 0x8664
}
