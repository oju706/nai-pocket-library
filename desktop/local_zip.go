package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const (
	localZipCatalogRoute = "/api/local-zip/catalog"
	localZipImportRoute  = "/api/local-zip/import"
	localZipRemoveRoute  = "/api/local-zip/remove"
	localZipPhotoRoute   = "/local-zip-photo/"

	localZipMaxArchiveBytes   = int64(2 * 1024 * 1024 * 1024)
	localZipMaxExpandedBytes  = int64(2 * 1024 * 1024 * 1024)
	localZipMaxCatalogBytes   = int64(4 * 1024 * 1024)
	localZipMaxManifestBytes  = localZipMaxCatalogBytes
	localZipMaxImageBytes     = int64(12 * 1024 * 1024)
	localZipMaxThumbnailBytes = int64(512 * 1024)
	localZipMaxModelsBytes    = int64(256 * 1024)
	localZipMaxEntries        = 10000
	localZipMaxArchiveName    = 1024
)

var (
	localZipImageIDPattern     = regexp.MustCompile(`^[0-9]{1,16}$`)
	localZipStyleIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	localZipDigestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	localZipCommunityName      = regexp.MustCompile(`^[a-f0-9]{64}\.webp$`)
	localZipRevisionPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
	localZipPhotoIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	localZipImageExtension     = map[string]bool{".webp": true, ".png": true, ".jpg": true, ".jpeg": true}
	localZipCommunityURLStart  = "https://arca.live/b/aiart/"
	localZipStateFilename      = "current.json"
	localZipStateBackup        = "current.json.bak"
	localZipPackagePrefix      = "package-"
	localZipPackageSuffix      = ".zip"
	localZipDefaultPackageName = "本地图片 ZIP"
)

// localZip mounts one user-selected ZIP as an application-owned private copy.
// Images are read directly from the archive through archive/zip on demand.
type localZip struct {
	webRoot string
	root    string

	importMu sync.Mutex
	loadMu   sync.Mutex
	loaded   bool

	mu      sync.RWMutex
	current *localZipIndex
}

type localZipIndex struct {
	path     string
	title    string
	revision string
	catalog  []byte
	photos   map[string]*localZipPhoto
}

type localZipPhoto struct {
	id        string
	title     string
	model     string
	source    string
	postID    string
	original  localZipEntry
	thumbnail *localZipEntry
}

type localZipEntry struct {
	name   string
	bytes  int64
	sha256 string
	mime   string
}

type localZipState struct {
	File     string `json:"file"`
	Title    string `json:"title"`
	Revision string `json:"revision"`
}

type localZipCatalogDocument struct {
	Title    string                 `json:"title"`
	Revision string                 `json:"revision"`
	Images   []localZipCatalogImage `json:"images"`
}

type localZipCatalogImage struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Section   string `json:"section"`
	Rating    string `json:"rating"`
	Model     string `json:"model"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256,omitempty"`
	Source    string `json:"source"`
	PostID    string `json:"postId"`
	Thumbnail string `json:"thumbnail"`
	Original  string `json:"original"`
}

type localZipCommunityManifest struct {
	Format    string                         `json:"format"`
	Version   int                            `json:"version"`
	FileCount int                            `json:"file_count"`
	Files     []localZipCommunityManifestRow `json:"files"`
}

type localZipCommunityManifestRow struct {
	ImageID   json.RawMessage `json:"image_id"`
	Name      string          `json:"name"`
	SHA256    string          `json:"sha256"`
	SourceURL string          `json:"source_url"`
	Bytes     int64           `json:"bytes"`
}

type localZipTestBatch struct {
	Library string                 `json:"library"`
	Name    string                 `json:"name"`
	Origin  string                 `json:"origin"`
	Items   []localZipTestBatchRow `json:"items"`
}

type localZipTestBatchRow struct {
	Status       string             `json:"status"`
	StyleID      string             `json:"style_id"`
	OutputFormat string             `json:"output_format"`
	Style        *localZipTestStyle `json:"style"`
	Payload      *localZipTestData  `json:"payload"`
}

type localZipTestStyle struct {
	Name      string `json:"name"`
	SourceURL string `json:"source_url"`
}

type localZipTestData struct {
	Model string `json:"model"`
}

type localZipModels struct {
	Format         string            `json:"format"`
	Version        int               `json:"version"`
	ManifestSHA256 string            `json:"manifestSha256"`
	Models         map[string]string `json:"models"`
}

// newLocalZip creates the local ZIP handler. Loading is lazy so startup can
// tolerate a package copied by an interrupted prior process.
func newLocalZip(cacheRoot, webRoot string) *localZip {
	return &localZip{
		webRoot: webRoot,
		root:    filepath.Join(cacheRoot, "local-zip"),
	}
}

func (library *localZip) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch {
	case request.URL.Path == localZipCatalogRoute:
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.Header().Set("Allow", "GET, HEAD")
			writeAPIFailure(writer, request, http.StatusMethodNotAllowed, "仅支持 GET 和 HEAD")
			return
		}
		library.serveCatalog(writer, request)
	case request.URL.Path == localZipImportRoute:
		if request.Method != http.MethodPost {
			writer.Header().Set("Allow", "POST")
			writeAPIFailure(writer, request, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		library.serveImport(writer, request)
	case request.URL.Path == localZipRemoveRoute:
		if request.Method != http.MethodPost {
			writer.Header().Set("Allow", "POST")
			writeAPIFailure(writer, request, http.StatusMethodNotAllowed, "仅支持 POST")
			return
		}
		library.serveRemove(writer, request)
	case strings.HasPrefix(request.URL.Path, localZipPhotoRoute):
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.Header().Set("Allow", "GET, HEAD")
			writeAPIFailure(writer, request, http.StatusMethodNotAllowed, "仅支持 GET 和 HEAD")
			return
		}
		library.servePhoto(writer, request)
	default:
		writeAPIFailure(writer, request, http.StatusNotFound, "接口不存在")
	}
}

func (library *localZip) serveCatalog(writer http.ResponseWriter, request *http.Request) {
	library.ensureLoaded()
	library.mu.RLock()
	defer library.mu.RUnlock()
	writer.Header().Set("Cache-Control", "no-store")
	if library.current == nil {
		writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", []byte("null"))
		return
	}
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", library.current.catalog)
}

func (library *localZip) serveImport(writer http.ResponseWriter, request *http.Request) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "application/zip") {
		writeAPIFailure(writer, request, http.StatusUnsupportedMediaType, "请以 application/zip 上传本地图片包。")
		return
	}
	if request.ContentLength > localZipMaxArchiveBytes {
		writeAPIFailure(writer, request, http.StatusRequestEntityTooLarge, "ZIP 不能超过 2 GiB。")
		return
	}
	index, err := library.importArchive(request)
	if err != nil {
		var public *routeError
		switch {
		case errors.As(err, &public):
			writeRouteFailure(writer, request, err)
		case errors.Is(err, errResourceTooLarge):
			writeAPIFailure(writer, request, http.StatusRequestEntityTooLarge, "ZIP 超出本地图包限制。")
		default:
			writeRouteFailure(writer, request, err)
		}
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", index.catalog)
}

func (library *localZip) serveRemove(writer http.ResponseWriter, request *http.Request) {
	if err := library.remove(); err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", []byte("true"))
}

func (library *localZip) servePhoto(writer http.ResponseWriter, request *http.Request) {
	parts, err := pathSegments(request.URL.Path)
	if err != nil || len(parts) != 4 || parts[0] != "local-zip-photo" ||
		!localZipRevisionPattern.MatchString(parts[1]) ||
		!localZipPhotoIDPattern.MatchString(parts[2]) ||
		(parts[3] != "thumb" && parts[3] != "original") {
		writeRouteFailure(writer, request, notFound("图片不存在。"))
		return
	}
	data, contentType, err := library.photo(request.Context(), parts[1], parts[2], parts[3] == "thumb")
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writeBytes(writer, request, http.StatusOK, contentType, data)
}

func (library *localZip) importArchive(request *http.Request) (*localZipIndex, error) {
	library.importMu.Lock()
	defer library.importMu.Unlock()
	library.ensureLoaded()

	title, err := localZipRequestTitle(request.Header.Get("X-Pocket-Filename"))
	if err != nil {
		return nil, badRequest("ZIP 文件名编码无效。")
	}
	if err := os.MkdirAll(library.root, 0o700); err != nil {
		return nil, err
	}
	staging, err := os.CreateTemp(library.root, ".import-*")
	if err != nil {
		return nil, err
	}
	stagingName := staging.Name()
	committed := false
	defer func() {
		_ = staging.Close()
		if !committed {
			_ = os.Remove(stagingName)
		}
	}()
	if err := staging.Chmod(0o600); err != nil {
		return nil, err
	}

	archiveHash := sha256.New()
	copied, err := io.Copy(io.MultiWriter(staging, archiveHash), io.LimitReader(request.Body, localZipMaxArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if copied > localZipMaxArchiveBytes {
		return nil, errResourceTooLarge
	}
	if err := request.Context().Err(); err != nil {
		return nil, err
	}
	if err := staging.Sync(); err != nil {
		return nil, err
	}
	if err := staging.Close(); err != nil {
		return nil, err
	}

	index, err := library.inspectZip(stagingName, title, hex.EncodeToString(archiveHash.Sum(nil)))
	if err != nil {
		return nil, localZipArchiveFailure(err)
	}
	if index.revision == "" || !localZipDigestPattern.MatchString(index.revision) {
		return nil, badRequest("无法确定本地图包版本。")
	}

	finalName := localZipPackagePrefix + strings.TrimPrefix(filepath.Base(stagingName), ".import-") + localZipPackageSuffix
	finalPath := filepath.Join(library.root, finalName)
	if err := os.Rename(stagingName, finalPath); err != nil {
		return nil, err
	}
	stagingName = finalPath
	index.path = finalPath
	state := localZipState{File: finalName, Title: index.title, Revision: index.revision}

	library.mu.Lock()
	previous := library.current
	if err := library.writeState(state); err != nil {
		library.mu.Unlock()
		return nil, err
	}
	library.current = index
	library.mu.Unlock()
	committed = true

	if previous != nil && previous.path != index.path {
		_ = os.Remove(previous.path)
	}
	_ = library.cleanupPackages(index.path)
	return index, nil
}

func (library *localZip) remove() error {
	library.importMu.Lock()
	defer library.importMu.Unlock()
	library.ensureLoaded()

	library.mu.Lock()
	defer library.mu.Unlock()
	if err := os.Remove(filepath.Join(library.root, localZipStateFilename)); err != nil &&
		!errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(filepath.Join(library.root, localZipStateBackup))
	library.current = nil
	return library.cleanupPackages("")
}

func (library *localZip) photo(ctx context.Context, revision, id string, thumbnail bool) ([]byte, string, error) {
	library.ensureLoaded()
	library.mu.RLock()
	defer library.mu.RUnlock()
	if library.current == nil || library.current.revision != revision {
		return nil, "", notFound("图包已更换，请重新打开。")
	}
	photo := library.current.photos[id]
	if photo == nil {
		return nil, "", notFound("这张图片不在本地图包中。")
	}
	entry := photo.original
	limit := localZipMaxImageBytes
	if thumbnail && photo.thumbnail != nil {
		entry = *photo.thumbnail
		limit = localZipMaxThumbnailBytes
	}
	data, err := readLocalZipFile(library.current.path, entry, limit, ctx)
	if err != nil {
		return nil, "", err
	}
	contentType := imageType(data)
	if contentType != "image/webp" && contentType != "image/png" && contentType != "image/jpeg" {
		return nil, "", errors.New("本地图包中的图片格式无效。")
	}
	if entry.mime != "" && contentType != entry.mime {
		return nil, "", errors.New("图片扩展名与内容不符。")
	}
	if entry.sha256 != "" && sha256Hex(data) != entry.sha256 {
		return nil, "", errors.New("图片校验失败，请重新导入图包。")
	}
	return data, contentType, nil
}

func (library *localZip) photoSize(revision, id string) int64 {
	library.ensureLoaded()
	library.mu.RLock()
	defer library.mu.RUnlock()
	if library.current == nil || library.current.revision != revision || library.current.photos[id] == nil {
		return 0
	}
	return library.current.photos[id].original.bytes
}

func (library *localZip) ensureLoaded() {
	library.loadMu.Lock()
	defer library.loadMu.Unlock()
	if library.loaded {
		return
	}
	library.loaded = true
	_ = library.recoverState()
	state, err := library.readState()
	if err != nil {
		return
	}
	filename, ok := library.validPackageName(state.File)
	if !ok || !localZipRevisionPattern.MatchString(state.Revision) {
		return
	}
	packagePath := filepath.Join(library.root, filename)
	index, err := library.inspectZip(packagePath, state.Title, state.Revision)
	if err != nil || index.revision != state.Revision {
		return
	}
	index.path = packagePath
	library.mu.Lock()
	library.current = index
	library.mu.Unlock()
	_ = library.cleanupPackages(packagePath)
}

func (library *localZip) inspectZip(filename, requestedTitle, archiveSHA string) (*localZipIndex, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 22 || info.Size() > localZipMaxArchiveBytes {
		return nil, errResourceTooLarge
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil {
		return nil, err
	}
	if len(archive.File) == 0 || len(archive.File) > localZipMaxEntries {
		return nil, errResourceTooLarge
	}

	entries := make(map[string]*zip.File, len(archive.File))
	var expanded int64
	for _, entry := range archive.File {
		if !localZipSafeArchiveName(entry.Name) {
			return nil, errors.New("ZIP 含有不安全的条目路径。")
		}
		if entries[entry.Name] != nil {
			return nil, errors.New("ZIP 含有重复条目。")
		}
		entries[entry.Name] = entry
		if entry.FileInfo().IsDir() || strings.HasSuffix(entry.Name, "/") {
			continue
		}
		if entry.FileInfo().Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("ZIP 含有符号链接。")
		}
		if entry.Flags&1 != 0 ||
			(entry.Method != zip.Store && entry.Method != zip.Deflate) {
			return nil, errors.New("ZIP 条目使用了不支持的压缩或加密方式。")
		}
		if entry.UncompressedSize64 > uint64(localZipMaxExpandedBytes) {
			return nil, errResourceTooLarge
		}
		expanded += int64(entry.UncompressedSize64)
		if expanded > localZipMaxExpandedBytes {
			return nil, errResourceTooLarge
		}
	}

	switch {
	case entries["manifest.json"] != nil && !entries["manifest.json"].FileInfo().IsDir():
		return library.inspectCommunityZip(entries)
	case entries["batch.json"] != nil && !entries["batch.json"].FileInfo().IsDir():
		return library.inspectTestZip(entries)
	default:
		return library.inspectImageZip(entries, requestedTitle, archiveSHA)
	}
}

func (library *localZip) inspectCommunityZip(entries map[string]*zip.File) (*localZipIndex, error) {
	entry := entries["manifest.json"]
	if entry.UncompressedSize64 > uint64(localZipMaxManifestBytes) {
		return nil, errResourceTooLarge
	}
	raw, err := readLocalZipEntry(entry, localZipMaxManifestBytes)
	if err != nil {
		return nil, err
	}
	manifestSHA := sha256Hex(raw)
	var manifest localZipCommunityManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	if manifest.Format != "naimakeartistgroup-shared-images" || manifest.Version != 2 ||
		manifest.FileCount < 1 || manifest.FileCount > localZipMaxEntries ||
		len(manifest.Files) != manifest.FileCount {
		return nil, errors.New("社区图包目录格式不受支持。")
	}

	models := library.readModels(manifestSHA)
	revision := manifestSHA
	photos := make(map[string]*localZipPhoto, len(manifest.Files))
	images := make([]localZipCatalogImage, 0, len(manifest.Files))
	for index, row := range manifest.Files {
		id := localZipCommunityID(row.ImageID)
		if !localZipImageIDPattern.MatchString(id) ||
			!localZipCommunityName.MatchString(row.Name) ||
			!localZipDigestPattern.MatchString(row.SHA256) ||
			!strings.HasPrefix(row.SourceURL, localZipCommunityURLStart) ||
			photos[id] != nil {
			return nil, fmt.Errorf("社区图包第 %d 项与目录不符。", index+1)
		}
		postID := strings.TrimPrefix(row.SourceURL, localZipCommunityURLStart)
		if !localZipImageIDPattern.MatchString(postID) ||
			row.Bytes < 12 || row.Bytes > localZipMaxImageBytes {
			return nil, fmt.Errorf("社区图包第 %d 项与目录不符。", index+1)
		}
		imageEntry := entries["arca_style_images/"+row.Name]
		if imageEntry == nil || imageEntry.FileInfo().IsDir() ||
			imageEntry.UncompressedSize64 != uint64(row.Bytes) {
			return nil, fmt.Errorf("社区图包第 %d 项缺少图片。", index+1)
		}
		photo := &localZipPhoto{
			id:     id,
			title:  "原帖 " + postID + " · 图 " + id,
			model:  localZipPackText(models[id], "未标注", 80),
			source: row.SourceURL,
			postID: postID,
			original: localZipEntry{
				name:   imageEntry.Name,
				bytes:  row.Bytes,
				sha256: row.SHA256,
				mime:   "image/webp",
			},
		}
		photos[id] = photo
		images = append(images, localZipCatalogImage{
			ID:        id,
			Title:     photo.title,
			Section:   "artist",
			Rating:    "unknown",
			Model:     photo.model,
			Bytes:     row.Bytes,
			SHA256:    row.SHA256,
			Source:    row.SourceURL,
			PostID:    postID,
			Thumbnail: localZipPhotoRoute + revision + "/" + id + "/thumb",
			Original:  localZipPhotoRoute + revision + "/" + id + "/original",
		})
	}

	// Community archives carry a digest for every image. Verify the complete
	// registered image set before replacing a previously mounted package.
	for _, photo := range photos {
		data, err := readLocalZipEntry(entryFor(entries, photo.original), localZipMaxImageBytes)
		if err != nil {
			return nil, err
		}
		if imageType(data) != "image/webp" || sha256Hex(data) != photo.original.sha256 {
			return nil, errors.New("社区图包图片与目录校验不符。")
		}
	}
	return library.finishIndex("Arca Live 社区画风合集", revision, photos, images)
}

func (library *localZip) inspectTestZip(entries map[string]*zip.File) (*localZipIndex, error) {
	entry := entries["batch.json"]
	if entry.UncompressedSize64 > uint64(localZipMaxCatalogBytes) {
		return nil, errResourceTooLarge
	}
	raw, err := readLocalZipEntry(entry, localZipMaxCatalogBytes)
	if err != nil {
		return nil, err
	}
	var batch localZipTestBatch
	if err := json.Unmarshal(raw, &batch); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(batch.Name)
	if batch.Library != "shared" || title == "" || len([]rune(title)) > 120 ||
		!strings.HasPrefix(batch.Origin, "shared_") ||
		len(batch.Items) < 1 || len(batch.Items) > localZipMaxEntries {
		return nil, errors.New("画风测试图包目录格式不受支持。")
	}

	ids := make(map[string]bool, len(batch.Items))
	photos := make(map[string]*localZipPhoto, len(batch.Items))
	images := make([]localZipCatalogImage, 0, len(batch.Items))
	revision := sha256Hex(raw)
	for index, row := range batch.Items {
		if row.Status != "completed" || !localZipStyleIDPattern.MatchString(row.StyleID) ||
			ids[row.StyleID] || (row.OutputFormat != "webp" && row.OutputFormat != "png") ||
			row.Style == nil || row.Payload == nil {
			return nil, fmt.Errorf("画风测试图包第 %d 项与目录不符。", index+1)
		}
		ids[row.StyleID] = true
		itemTitle := strings.TrimSpace(row.Style.Name)
		model := strings.TrimSpace(row.Payload.Model)
		if itemTitle == "" || len([]rune(itemTitle)) > 200 ||
			model == "" || len([]rune(model)) > 80 {
			return nil, fmt.Errorf("画风测试图包第 %d 项与目录不符。", index+1)
		}
		source := ""
		postID := ""
		if strings.HasPrefix(row.Style.SourceURL, localZipCommunityURLStart) {
			candidate := strings.TrimPrefix(row.Style.SourceURL, localZipCommunityURLStart)
			if localZipImageIDPattern.MatchString(candidate) {
				source = row.Style.SourceURL
				postID = candidate
			}
		}
		originalEntry := entries[row.StyleID+"."+row.OutputFormat]
		if originalEntry == nil || originalEntry.FileInfo().IsDir() ||
			originalEntry.UncompressedSize64 < 12 ||
			originalEntry.UncompressedSize64 > uint64(localZipMaxImageBytes) {
			return nil, fmt.Errorf("画风测试图包第 %d 项缺少图片。", index+1)
		}
		photo := &localZipPhoto{
			id:     row.StyleID,
			title:  itemTitle,
			model:  model,
			source: source,
			postID: postID,
			original: localZipEntry{
				name:  originalEntry.Name,
				bytes: int64(originalEntry.UncompressedSize64),
				mime:  "image/" + row.OutputFormat,
			},
		}
		if thumb := entries[row.StyleID+".jpg"]; thumb != nil && !thumb.FileInfo().IsDir() &&
			thumb.UncompressedSize64 > 0 && thumb.UncompressedSize64 <= uint64(localZipMaxThumbnailBytes) {
			photo.thumbnail = &localZipEntry{
				name:  thumb.Name,
				bytes: int64(thumb.UncompressedSize64),
			}
		}
		photos[photo.id] = photo
		images = append(images, localZipCatalogImage{
			ID:        photo.id,
			Title:     photo.title,
			Section:   "artist",
			Rating:    "unknown",
			Model:     photo.model,
			Bytes:     photo.original.bytes,
			Source:    photo.source,
			PostID:    photo.postID,
			Thumbnail: localZipPhotoRoute + revision + "/" + photo.id + "/thumb",
			Original:  localZipPhotoRoute + revision + "/" + photo.id + "/original",
		})
	}
	return library.finishIndex(title, revision, photos, images)
}

func (library *localZip) inspectImageZip(entries map[string]*zip.File, requestedTitle, archiveSHA string) (*localZipIndex, error) {
	revision := archiveSHA
	if !localZipRevisionPattern.MatchString(revision) {
		return nil, errors.New("无法确定本地图片包版本。")
	}
	title := strings.TrimSpace(requestedTitle)
	if title == "" {
		title = localZipDefaultPackageName
	}
	if len([]rune(title)) > 120 {
		title = string([]rune(title)[:120])
	}

	photos := make(map[string]*localZipPhoto)
	images := make([]localZipCatalogImage, 0)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry := entries[name]
		if entry.FileInfo().IsDir() || entry.FileInfo().Mode()&os.ModeSymlink != 0 ||
			!localZipImageExtension[strings.ToLower(path.Ext(entry.Name))] {
			continue
		}
		if entry.UncompressedSize64 < 12 || entry.UncompressedSize64 > uint64(localZipMaxImageBytes) {
			return nil, fmt.Errorf("图片 %q 大小超出本地图包限制。", entry.Name)
		}
		idHash := sha256.Sum256([]byte(entry.Name))
		id := hex.EncodeToString(idHash[:])
		base := strings.TrimSuffix(path.Base(entry.Name), path.Ext(entry.Name))
		photo := &localZipPhoto{
			id:    id,
			title: base,
			model: "未标注",
			original: localZipEntry{
				name:  entry.Name,
				bytes: int64(entry.UncompressedSize64),
			},
		}
		photos[id] = photo
		images = append(images, localZipCatalogImage{
			ID:        id,
			Title:     base,
			Section:   "artist",
			Rating:    "unknown",
			Model:     photo.model,
			Bytes:     photo.original.bytes,
			Thumbnail: localZipPhotoRoute + revision + "/" + id + "/thumb",
			Original:  localZipPhotoRoute + revision + "/" + id + "/original",
		})
	}
	if len(images) == 0 {
		return nil, errors.New("ZIP 中没有 WebP、PNG 或 JPEG 图片。")
	}
	return library.finishIndex(title, revision, photos, images)
}

func (library *localZip) finishIndex(title, revision string, photos map[string]*localZipPhoto, images []localZipCatalogImage) (*localZipIndex, error) {
	catalog, err := json.Marshal(localZipCatalogDocument{
		Title:    title,
		Revision: revision,
		Images:   images,
	})
	if err != nil {
		return nil, err
	}
	return &localZipIndex{
		title:    title,
		revision: revision,
		catalog:  catalog,
		photos:   photos,
	}, nil
}

func (library *localZip) readModels(manifestSHA string) map[string]string {
	if library.webRoot == "" || !localZipDigestPattern.MatchString(manifestSHA) {
		return nil
	}
	raw, ok := readCache(filepath.Join(library.webRoot, "community-style-models.json"), localZipMaxModelsBytes)
	if !ok {
		return nil
	}
	var models localZipModels
	if json.Unmarshal(raw, &models) != nil ||
		models.Format != "nai-pocket-community-models" ||
		models.Version != 1 || models.ManifestSHA256 != manifestSHA {
		return nil
	}
	result := make(map[string]string, len(models.Models))
	for id, model := range models.Models {
		model = strings.TrimSpace(model)
		if !localZipImageIDPattern.MatchString(id) || model == "" || len([]rune(model)) > 80 {
			return nil
		}
		result[id] = model
	}
	return result
}

func (library *localZip) readState() (localZipState, error) {
	var state localZipState
	raw, ok := readCache(filepath.Join(library.root, localZipStateFilename), 64*1024)
	if !ok {
		return state, os.ErrNotExist
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, err
	}
	if _, ok := library.validPackageName(state.File); !ok {
		return state, errors.New("invalid local ZIP state")
	}
	return state, nil
}

func (library *localZip) recoverState() error {
	currentPath := filepath.Join(library.root, localZipStateFilename)
	backupPath := filepath.Join(library.root, localZipStateBackup)
	if _, err := os.Stat(currentPath); errors.Is(err, os.ErrNotExist) {
		if _, backupErr := os.Stat(backupPath); backupErr == nil {
			if err := os.Rename(backupPath, currentPath); err != nil {
				return err
			}
		}
	}
	if _, err := os.Stat(currentPath); err == nil {
		_ = os.Remove(backupPath)
	}
	return nil
}

func (library *localZip) writeState(state localZipState) error {
	if _, ok := library.validPackageName(state.File); !ok ||
		!localZipRevisionPattern.MatchString(state.Revision) {
		return errors.New("invalid local ZIP state")
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(library.root, ".state-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(raw); err != nil {
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

	currentPath := filepath.Join(library.root, localZipStateFilename)
	backupPath := filepath.Join(library.root, localZipStateBackup)
	_ = os.Remove(backupPath)
	hadCurrent := false
	if err := os.Rename(currentPath, backupPath); err == nil {
		hadCurrent = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(temporaryName, currentPath); err != nil {
		if hadCurrent {
			_ = os.Rename(backupPath, currentPath)
		}
		return err
	}
	if hadCurrent {
		_ = os.Remove(backupPath)
	}
	return nil
}

func (library *localZip) cleanupPackages(keep string) error {
	entries, err := os.ReadDir(library.root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var firstError error
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), localZipPackagePrefix) ||
			!strings.HasSuffix(entry.Name(), localZipPackageSuffix) {
			continue
		}
		name, ok := library.validPackageName(entry.Name())
		if !ok || (keep != "" && filepath.Join(library.root, name) == keep) {
			continue
		}
		if err := os.Remove(filepath.Join(library.root, name)); err != nil &&
			!errors.Is(err, os.ErrNotExist) && firstError == nil {
			firstError = err
		}
	}
	return firstError
}

func (library *localZip) validPackageName(name string) (string, bool) {
	if name == "" || name != filepath.Base(name) ||
		!strings.HasPrefix(name, localZipPackagePrefix) ||
		!strings.HasSuffix(name, localZipPackageSuffix) ||
		strings.ContainsAny(name, "\x00/\\") {
		return "", false
	}
	return name, true
}

func localZipRequestTitle(header string) (string, error) {
	value := strings.TrimSpace(header)
	if value == "" {
		return localZipDefaultPackageName, nil
	}
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return "", err
	}
	decoded = strings.TrimSpace(strings.ReplaceAll(decoded, "\\", "/"))
	decoded = path.Base(decoded)
	if decoded == "" || decoded == "." || decoded == "/" || strings.ContainsRune(decoded, '\x00') {
		return "", errors.New("invalid filename")
	}
	title := strings.TrimSuffix(decoded, path.Ext(decoded))
	title = strings.TrimSpace(title)
	if title == "" {
		return localZipDefaultPackageName, nil
	}
	if len([]rune(title)) > 120 {
		title = string([]rune(title)[:120])
	}
	return title, nil
}

func localZipSafeArchiveName(name string) bool {
	if name == "" || len(name) > localZipMaxArchiveName || strings.ContainsAny(name, "\\\x00") ||
		strings.HasPrefix(name, "/") || strings.Contains(name, "//") {
		return false
	}
	isDirectory := strings.HasSuffix(name, "/")
	trimmed := strings.TrimSuffix(name, "/")
	if trimmed == "" {
		return false
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
	}
	return isDirectory || trimmed == name
}

func localZipCommunityID(value json.RawMessage) string {
	if len(value) > 0 && value[0] == '"' {
		var id string
		if json.Unmarshal(value, &id) == nil {
			return id
		}
		return ""
	}
	return string(value)
}

func localZipPackText(value, fallback string, limit int) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if len([]rune(value)) > limit {
		value = string([]rune(value)[:limit])
	}
	return value
}

func localZipArchiveFailure(err error) error {
	if errors.Is(err, errResourceTooLarge) {
		return errResourceTooLarge
	}
	if err == nil {
		return badRequest("本地图包无效。")
	}
	return badRequest(err.Error())
}

func entryFor(entries map[string]*zip.File, entry localZipEntry) *zip.File {
	if entry.name == "" {
		return nil
	}
	return entries[entry.name]
}

func readLocalZipEntry(entry *zip.File, limit int64) ([]byte, error) {
	if entry == nil || limit < 0 || entry.UncompressedSize64 > uint64(limit) {
		return nil, errResourceTooLarge
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(reader, limit+1))
	closeErr := reader.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if int64(len(data)) > limit {
		return nil, errResourceTooLarge
	}
	if int64(len(data)) != int64(entry.UncompressedSize64) {
		return nil, errors.New("ZIP 条目长度不符。")
	}
	return data, nil
}

func readLocalZipFile(filename string, registered localZipEntry, limit int64, ctx context.Context) ([]byte, error) {
	if registered.name == "" || limit < 0 || registered.bytes < 1 ||
		registered.bytes > limit {
		return nil, errors.New("本地图包条目无效。")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > localZipMaxArchiveBytes {
		return nil, errors.New("本地图包副本不可用。")
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil {
		return nil, err
	}
	var entry *zip.File
	for _, candidate := range archive.File {
		if candidate.Name == registered.name {
			entry = candidate
			break
		}
	}
	if entry == nil || entry.FileInfo().IsDir() ||
		int64(entry.UncompressedSize64) != registered.bytes {
		return nil, errors.New("本地图包目录与文件不符。")
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(&localZipContextReader{ctx: ctx, reader: reader}, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit || int64(len(data)) != registered.bytes ||
		int64(len(data)) != int64(entry.UncompressedSize64) {
		return nil, errors.New("本地图包图片长度不符。")
	}
	return data, nil
}

type localZipContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *localZipContextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	count, err := reader.reader.Read(buffer)
	if err == nil {
		if contextErr := reader.ctx.Err(); contextErr != nil {
			return count, contextErr
		}
	}
	return count, err
}

var _ http.Handler = (*localZip)(nil)
