package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	galleryFolderImageRoute    = "/gallery-folder-image/"
	galleryFolderImageLimit    = 32 << 20
	galleryFolderRegistryLimit = 4 << 20
)

var galleryFolderFinalPath = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")

type galleryFolderEntry struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type galleryFolderView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
}

type galleryFolderItem struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	RelativePath string `json:"relativePath"`
	Bytes        int64  `json:"bytes"`
	Modified     int64  `json:"modified"`
	Format       string `json:"format"`
	PreviewURL   string `json:"previewUrl"`
}

type galleryFolderIndex struct {
	items []galleryFolderItem
	paths map[string]string
}

type galleryFolders struct {
	registry string
	pick     func() (string, error)
	pickerMu sync.Mutex
	mu       sync.Mutex
	indexes  map[string]*galleryFolderIndex
}

func newGalleryFolders(cacheRoot string, pick func() (string, error)) *galleryFolders {
	return &galleryFolders{
		registry: filepath.Join(cacheRoot, "gallery-folders.json"),
		pick:     pick,
		indexes:  make(map[string]*galleryFolderIndex),
	}
}

func (folders *galleryFolders) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var err error
	switch request.URL.Path {
	case "/api/gallery-folders":
		err = folders.list(writer, request)
	case "/api/gallery-folders/pick":
		err = folders.add(writer, request)
	case "/api/gallery-folders/remove":
		err = folders.remove(writer, request)
	case "/api/gallery-folders/images":
		err = folders.images(writer, request)
	default:
		if path, ok := strings.CutPrefix(request.URL.Path, galleryFolderImageRoute); ok {
			err = folders.image(writer, request, path)
		} else {
			err = notFound("找不到这个文件夹接口。")
		}
	}
	if err != nil {
		writeRouteFailure(writer, request, err)
	}
}

func galleryFolderID(value string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(value)))
	return hex.EncodeToString(digest[:])
}

func (folders *galleryFolders) entries() ([]galleryFolderEntry, error) {
	file, err := os.Open(folders.registry)
	if errors.Is(err, os.ErrNotExist) {
		return []galleryFolderEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := readLimited(file, galleryFolderRegistryLimit)
	if err != nil {
		return nil, err
	}
	var entries []galleryFolderEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !filepath.IsAbs(entry.Path) || entry.ID != galleryFolderID(entry.Path) {
			return nil, errors.New("invalid gallery folder registry")
		}
	}
	return entries, nil
}

func (folders *galleryFolders) save(entries []galleryFolderEntry) error {
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	if len(data) > galleryFolderRegistryLimit {
		return errResourceTooLarge
	}
	if err := os.MkdirAll(filepath.Dir(folders.registry), 0o700); err != nil {
		return err
	}
	return writeWindowsActivation(folders.registry, data)
}

func galleryFolderIsReparse(info fs.FileInfo) bool {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return info.Mode()&os.ModeSymlink != 0 || ok && data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

func galleryFolderPath(path string) string {
	// The final path reported for a Windows file handle includes a DOS device prefix.
	if strings.HasPrefix(path, `\\?\UNC\`) {
		path = `\\` + path[len(`\\?\UNC\`):]
	} else {
		path = strings.TrimPrefix(path, `\\?\`)
	}
	return filepath.Clean(path)
}

func (entry galleryFolderEntry) view() galleryFolderView {
	name := filepath.Base(entry.Path)
	if name == `\` {
		name = entry.Path
	}
	info, err := os.Lstat(entry.Path)
	available := err == nil && info.IsDir() && !galleryFolderIsReparse(info)
	if available {
		actual, err := filepath.EvalSymlinks(entry.Path)
		available = err == nil && strings.EqualFold(galleryFolderPath(actual), entry.Path)
	}
	return galleryFolderView{ID: entry.ID, Name: name, Available: available}
}

func findGalleryFolder(entries []galleryFolderEntry, id string) (galleryFolderEntry, error) {
	if !validPersonalGalleryID(id) {
		return galleryFolderEntry{}, badRequest("文件夹编号不正确。")
	}
	for _, entry := range entries {
		if entry.ID == id {
			return entry, nil
		}
	}
	return galleryFolderEntry{}, notFound("该文件夹已从图库移除。")
}

func (folders *galleryFolders) list(writer http.ResponseWriter, request *http.Request) error {
	folders.mu.Lock()
	entries, err := folders.entries()
	folders.mu.Unlock()
	if err != nil {
		return err
	}
	views := make([]galleryFolderView, 0, len(entries))
	for _, entry := range entries {
		views = append(views, entry.view())
	}
	writePersonalGalleryJSON(writer, request, map[string]any{"folders": views})
	return nil
}

func (folders *galleryFolders) add(writer http.ResponseWriter, request *http.Request) error {
	if folders.pick == nil {
		return unavailable("当前无法打开 Windows 文件夹选择窗口。")
	}
	if !folders.pickerMu.TryLock() {
		return &routeError{status: http.StatusConflict, message: "文件夹选择窗口已打开。"}
	}
	defer folders.pickerMu.Unlock()
	var body struct{}
	if err := readPersonalGalleryPayload(request, &body); err != nil {
		return err
	}
	path, err := folders.pick()
	if err != nil {
		return unavailable(err.Error())
	}
	if path == "" {
		writePersonalGalleryJSON(writer, request, map[string]any{"folder": nil})
		return nil
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil || !filepath.IsAbs(path) {
		return badRequest("无法读取所选文件夹。")
	}
	path = galleryFolderPath(path)
	entry := galleryFolderEntry{ID: galleryFolderID(path), Path: path}
	view := entry.view()
	if !view.Available {
		return badRequest("所选文件夹已移动或无法读取。")
	}

	folders.mu.Lock()
	defer folders.mu.Unlock()
	entries, err := folders.entries()
	if err != nil {
		return err
	}
	if _, err := findGalleryFolder(entries, entry.ID); err != nil {
		if err := folders.save(append(entries, entry)); err != nil {
			return err
		}
	}
	writePersonalGalleryJSON(writer, request, map[string]any{"folder": view})
	return nil
}

func (folders *galleryFolders) remove(writer http.ResponseWriter, request *http.Request) error {
	var body struct {
		ID string `json:"id"`
	}
	if err := readPersonalGalleryPayload(request, &body); err != nil {
		return err
	}
	if !validPersonalGalleryID(body.ID) {
		return badRequest("文件夹编号不正确。")
	}
	folders.mu.Lock()
	defer folders.mu.Unlock()
	entries, err := folders.entries()
	if err != nil {
		return err
	}
	for index, entry := range entries {
		if entry.ID != body.ID {
			continue
		}
		if err := folders.save(append(entries[:index], entries[index+1:]...)); err != nil {
			return err
		}
		delete(folders.indexes, body.ID)
		writePersonalGalleryJSON(writer, request, true)
		return nil
	}
	writePersonalGalleryJSON(writer, request, false)
	return nil
}

func scanGalleryFolder(ctx context.Context, entry galleryFolderEntry) (*galleryFolderIndex, error) {
	index := &galleryFolderIndex{items: []galleryFolderItem{}, paths: make(map[string]string)}
	err := filepath.WalkDir(entry.Path, func(path string, child fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			if path == entry.Path {
				return walkErr
			}
			return nil
		}
		info, err := child.Info()
		if err != nil {
			if child.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if galleryFolderIsReparse(info) {
			if child.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() || !localZipImageExtension[strings.ToLower(filepath.Ext(path))] ||
			info.Size() <= 0 || info.Size() > galleryFolderImageLimit {
			return nil
		}
		relative, err := filepath.Rel(entry.Path, path)
		if err != nil || !filepath.IsLocal(relative) {
			return nil
		}
		relative = filepath.ToSlash(relative)
		id := galleryFolderID(relative)
		format := strings.ToUpper(strings.TrimPrefix(filepath.Ext(path), "."))
		if format == "JPG" {
			format = "JPEG"
		}
		index.paths[id] = path
		index.items = append(index.items, galleryFolderItem{
			ID: id, Name: child.Name(), RelativePath: relative, Format: format,
			Bytes: info.Size(), Modified: info.ModTime().UnixMilli(),
			PreviewURL: galleryFolderImageRoute + entry.ID + "/" + id,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(index.items, func(i, j int) bool {
		return strings.ToLower(index.items[i].RelativePath) < strings.ToLower(index.items[j].RelativePath)
	})
	return index, nil
}

func (folders *galleryFolders) images(writer http.ResponseWriter, request *http.Request) error {
	query := request.URL.Query()
	page := 0
	if raw := query.Get("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			return badRequest("文件夹页码不正确。")
		}
		page = parsed
	}

	folders.mu.Lock()
	defer folders.mu.Unlock()
	entries, err := folders.entries()
	if err != nil {
		return err
	}
	entry, err := findGalleryFolder(entries, query.Get("id"))
	if err != nil {
		return err
	}
	view := entry.view()
	items := []galleryFolderItem{}
	if view.Available {
		index := folders.indexes[entry.ID]
		if index == nil || query.Get("refresh") == "1" {
			index, err = scanGalleryFolder(request.Context(), entry)
			if err != nil {
				return unavailable("无法读取该文件夹。请检查位置和读取权限。")
			}
			folders.indexes[entry.ID] = index
		}
		items = index.items
	} else {
		delete(folders.indexes, entry.ID)
	}
	pages := max(1, (len(items)+personalGalleryPageSize-1)/personalGalleryPageSize)
	page = min(page, pages-1)
	start := page * personalGalleryPageSize
	end := min(len(items), start+personalGalleryPageSize)
	writePersonalGalleryJSON(writer, request, struct {
		Items  []galleryFolderItem `json:"items"`
		Total  int                 `json:"total"`
		Page   int                 `json:"page"`
		Pages  int                 `json:"pages"`
		Folder galleryFolderView   `json:"folder"`
	}{items[start:end], len(items), page, pages, view})
	return nil
}

func (folders *galleryFolders) imagePath(folderID, fileID string) (string, error) {
	folders.mu.Lock()
	defer folders.mu.Unlock()
	entries, err := folders.entries()
	if err != nil {
		return "", err
	}
	if _, err := findGalleryFolder(entries, folderID); err != nil {
		return "", err
	}
	if index := folders.indexes[folderID]; index != nil && index.paths[fileID] != "" {
		return index.paths[fileID], nil
	}
	return "", notFound("请刷新文件夹后重新打开这张图片。")
}

func (folders *galleryFolders) image(writer http.ResponseWriter, request *http.Request, path string) error {
	folderID, fileID, ok := strings.Cut(path, "/")
	if !ok || !validPersonalGalleryID(folderID) || !validPersonalGalleryID(fileID) {
		return notFound("找不到这张图片。")
	}
	selected, err := folders.imagePath(folderID, fileID)
	if err != nil {
		return err
	}
	info, err := os.Lstat(selected)
	if err != nil || !info.Mode().IsRegular() || galleryFolderIsReparse(info) {
		return notFound("图片已移动或无法读取。")
	}
	file, err := os.Open(selected)
	if err != nil {
		return notFound("图片已移动或无法读取。")
	}
	defer file.Close()
	// Validate the opened handle so replacing an indexed path with a link or junction
	// cannot make the local server expose a file outside the chosen folder.
	var fullName [32768]uint16
	count, _, _ := galleryFolderFinalPath.Call(file.Fd(), uintptr(unsafe.Pointer(&fullName[0])), uintptr(len(fullName)), 0)
	if count == 0 || count >= uintptr(len(fullName)) ||
		!strings.EqualFold(galleryFolderPath(syscall.UTF16ToString(fullName[:count])), selected) {
		return notFound("图片位置已改变，请刷新文件夹。")
	}
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || opened.Size() <= 0 || opened.Size() > galleryFolderImageLimit {
		return badRequest("图片为空、无法读取或超过 32 MB。")
	}
	var header [32]byte
	n, _ := file.ReadAt(header[:], 0)
	contentType := imageType(header[:n])
	if contentType != "image/webp" && contentType != "image/png" && contentType != "image/jpeg" {
		return badRequest("只支持 PNG、WebP 或 JPEG 图片。")
	}
	writer.Header().Set("Content-Type", contentType)
	http.ServeContent(writer, request, filepath.Base(selected), opened.ModTime(), io.NewSectionReader(file, 0, opened.Size()))
	return nil
}
