package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image/jpeg"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	personalGalleryPageSize      = 24
	personalGalleryPreviewLimit  = 512 << 10
	personalGalleryMetadataLimit = 2 << 20
	personalGalleryPreviewPrefix = "data:image/jpeg;base64,"
)

type personalGallery struct {
	directory string
	mu        sync.Mutex
	index     []personalGalleryItem
	bytes     int64
}

type personalGalleryItem struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Format       string `json:"format"`
	Bytes        int64  `json:"bytes"`
	CreatedAt    int64  `json:"createdAt"`
	Kind         string `json:"kind"`
	SourceLinked bool   `json:"sourceLinked"`
}

type personalGalleryPage struct {
	Items []personalGalleryItem `json:"items"`
	Total int                   `json:"total"`
	Bytes int64                 `json:"bytes"`
	Page  int                   `json:"page"`
	Pages int                   `json:"pages"`
}

type personalGallerySave struct {
	Name     string          `json:"name"`
	Preview  string          `json:"preview"`
	Metadata json.RawMessage `json:"metadata"`
}

func newPersonalGallery(cacheRoot string) *personalGallery {
	return &personalGallery{directory: filepath.Join(cacheRoot, "personal-gallery")}
}

func (gallery *personalGallery) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var err error
	switch request.URL.Path {
	case "/api/personal-gallery":
		err = gallery.list(writer, request)
	case "/api/personal-gallery/metadata":
		err = gallery.metadata(writer, request)
	case "/api/personal-gallery/save":
		err = gallery.save(writer, request)
	case "/api/personal-gallery/delete":
		err = gallery.delete(writer, request)
	default:
		if id, ok := strings.CutPrefix(request.URL.Path, "/gallery-image/"); ok {
			err = gallery.image(writer, request, id)
		} else {
			err = personalGalleryRouteError(http.StatusNotFound, "找不到这个图库接口。")
		}
	}
	if err != nil {
		var route *routeError
		if errors.As(err, &route) {
			writeAPIFailure(writer, request, route.status, route.message)
			return
		}
		log.Printf("personal gallery %s: %v", request.URL.Path, err)
		writeAPIFailure(writer, request, http.StatusInternalServerError, "无法读取或写入本机图库，请检查磁盘空间后重试。")
	}
}

func personalGalleryRouteError(status int, message string) error {
	return &routeError{status: status, message: message}
}

func readPersonalGalleryPayload(request *http.Request, target any) error {
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil || decoder.Decode(new(any)) != io.EOF {
		return personalGalleryRouteError(http.StatusBadRequest, "图库请求格式不正确或超过允许大小。")
	}
	return nil
}

func writePersonalGalleryJSON(writer http.ResponseWriter, request *http.Request, value any) {
	data, _ := json.Marshal(value)
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
}

func validPersonalGalleryID(id string) bool {
	if len(id) != sha256.Size*2 || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func (gallery *personalGallery) entry(id string) (string, error) {
	if !validPersonalGalleryID(id) {
		return "", personalGalleryRouteError(http.StatusBadRequest, "无效的图库条目。")
	}
	name := filepath.Join(gallery.directory, id)
	info, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) || err == nil && !info.IsDir() {
		return "", personalGalleryRouteError(http.StatusNotFound, "图库中找不到这个条目。")
	}
	return name, err
}

func (gallery *personalGallery) list(writer http.ResponseWriter, request *http.Request) error {
	page := 0
	if raw := request.URL.Query().Get("page"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			return personalGalleryRouteError(http.StatusBadRequest, "图库页码无效。")
		}
		page = value
	}
	gallery.mu.Lock()
	if gallery.index == nil {
		items, totalBytes, err := gallery.readItems()
		if err != nil {
			gallery.mu.Unlock()
			return err
		}
		sort.Slice(items, func(i, j int) bool {
			if items[i].CreatedAt == items[j].CreatedAt {
				return items[i].ID < items[j].ID
			}
			return items[i].CreatedAt > items[j].CreatedAt
		})
		gallery.index, gallery.bytes = items, totalBytes
	}
	items, totalBytes := gallery.index, gallery.bytes
	gallery.mu.Unlock()
	pages := max(1, (len(items)+personalGalleryPageSize-1)/personalGalleryPageSize)
	page = min(page, pages-1)
	start := page * personalGalleryPageSize
	end := min(len(items), start+personalGalleryPageSize)
	writePersonalGalleryJSON(writer, request, personalGalleryPage{
		Items: items[start:end], Total: len(items), Bytes: totalBytes, Page: page, Pages: pages,
	})
	return nil
}

func (gallery *personalGallery) readItems() ([]personalGalleryItem, int64, error) {
	items := []personalGalleryItem{}
	entries, err := os.ReadDir(gallery.directory)
	if errors.Is(err, os.ErrNotExist) {
		return items, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	var totalBytes int64
	for _, entry := range entries {
		if !entry.IsDir() || !validPersonalGalleryID(entry.Name()) {
			continue
		}
		directory := filepath.Join(gallery.directory, entry.Name())
		record, ok := readCache(filepath.Join(directory, "item.json"), 8<<10)
		preview, err := os.Lstat(filepath.Join(directory, "preview.jpg"))
		var item personalGalleryItem
		if !ok || json.Unmarshal(record, &item) != nil || item.ID != entry.Name() ||
			err != nil || !preview.Mode().IsRegular() || preview.Size() <= 0 ||
			preview.Size() > personalGalleryPreviewLimit {
			continue
		}
		item.Bytes = preview.Size()
		totalBytes += item.Bytes + int64(len(record))
		if metadata, err := os.Lstat(filepath.Join(directory, "metadata.json")); err == nil &&
			metadata.Mode().IsRegular() && metadata.Size() <= personalGalleryMetadataLimit {
			totalBytes += metadata.Size()
		}
		items = append(items, item)
	}
	return items, totalBytes, nil
}

func normalizePersonalGalleryName(name string) string {
	name = strings.TrimSpace(strings.Map(func(char rune) rune {
		if unicode.IsControl(char) {
			return -1
		}
		return char
	}, name))
	if name == "" {
		return "未命名原图"
	}
	letters := []rune(name)
	return string(letters[:min(len(letters), 300)])
}

func decodePersonalGalleryPreview(preview string) ([]byte, error) {
	encoded, ok := strings.CutPrefix(preview, personalGalleryPreviewPrefix)
	if !ok || len(encoded) > base64.StdEncoding.EncodedLen(personalGalleryPreviewLimit) {
		return nil, personalGalleryRouteError(http.StatusBadRequest, "小预览必须是 512 KB 以内的 JPEG 图片。")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) > personalGalleryPreviewLimit {
		return nil, personalGalleryRouteError(http.StatusBadRequest, "小预览的图片数据无效。")
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 512 || config.Height > 512 {
		return nil, personalGalleryRouteError(http.StatusBadRequest, "小预览尺寸无效，最长边不能超过 512 像素。")
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		return nil, personalGalleryRouteError(http.StatusBadRequest, "小预览不是可读取的 JPEG 图片。")
	}
	return data, nil
}

func personalGalleryMetadata(raw json.RawMessage) ([]byte, error) {
	if len(raw) > personalGalleryMetadataLimit {
		return nil, personalGalleryRouteError(http.StatusBadRequest, "生成信息超过图库保存上限。")
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, personalGalleryRouteError(http.StatusBadRequest, "生成信息格式不正确。")
	}
	delete(fields, "preview")
	delete(fields, "promptCached")
	for _, name := range []string{
		"model", "metadata", "parameters", "rawComment", "prompt", "negativePrompt",
		"actualPrompt", "actualNegativePrompt", "characters", "negativeCharacters",
		"actualCharacters", "actualNegativeCharacters", "v4Prompt", "v4NegativePrompt",
	} {
		value := strings.TrimSpace(string(fields[name]))
		if value != "" && value != `""` && value != "null" && value != "{}" && value != "[]" {
			fields["promptCached"] = json.RawMessage("true")
			encoded, err := json.Marshal(fields)
			if len(encoded) > personalGalleryMetadataLimit {
				return nil, personalGalleryRouteError(http.StatusBadRequest, "生成信息超过图库保存上限。")
			}
			return encoded, err
		}
	}
	return nil, nil
}

func (gallery *personalGallery) save(writer http.ResponseWriter, request *http.Request) error {
	var payload personalGallerySave
	if err := readPersonalGalleryPayload(request, &payload); err != nil {
		return err
	}
	preview, err := decodePersonalGalleryPreview(payload.Preview)
	if err != nil {
		return err
	}
	metadata, err := personalGalleryMetadata(payload.Metadata)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, _ = hash.Write(preview)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write(metadata)
	id := hex.EncodeToString(hash.Sum(nil))
	item := personalGalleryItem{
		ID: id, Name: normalizePersonalGalleryName(payload.Name), Format: "JPEG",
		Bytes: int64(len(preview)), CreatedAt: time.Now().UnixMilli(), Kind: "preview",
	}
	gallery.mu.Lock()
	added, err := gallery.store(item, preview, metadata)
	if added {
		gallery.index = nil
	}
	gallery.mu.Unlock()
	if err != nil {
		return err
	}
	writePersonalGalleryJSON(writer, request, struct {
		ID           string `json:"id"`
		Added        bool   `json:"added"`
		PromptCached bool   `json:"promptCached"`
	}{id, added, len(metadata) > 0})
	return nil
}

func (gallery *personalGallery) store(item personalGalleryItem, preview, metadata []byte) (bool, error) {
	if err := os.MkdirAll(gallery.directory, 0o700); err != nil {
		return false, err
	}
	target := filepath.Join(gallery.directory, item.ID)
	if info, err := os.Lstat(target); err == nil {
		if info.IsDir() {
			return false, nil
		}
		return false, errors.New("gallery entry path is already in use")
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	staging, err := os.MkdirTemp(gallery.directory, ".pending-")
	if err != nil {
		return false, err
	}
	defer removePersonalGalleryDirectory(staging)
	record, err := json.Marshal(item)
	if err != nil {
		return false, err
	}
	for name, data := range map[string][]byte{"item.json": record, "preview.jpg": preview, "metadata.json": metadata} {
		if len(data) > 0 {
			if err := writeCache(filepath.Join(staging, name), data); err != nil {
				return false, err
			}
		}
	}
	if err := os.Rename(staging, target); err != nil {
		if info, statErr := os.Lstat(target); statErr == nil && info.IsDir() {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func removePersonalGalleryDirectory(directory string) {
	for _, filename := range []string{"item.json", "preview.jpg", "metadata.json"} {
		_ = os.Remove(filepath.Join(directory, filename))
	}
	_ = os.Remove(directory)
}

func (gallery *personalGallery) readEntryFile(id, filename string, limit int64) ([]byte, error) {
	gallery.mu.Lock()
	defer gallery.mu.Unlock()
	directory, err := gallery.entry(id)
	if err != nil {
		return nil, err
	}
	name := filepath.Join(directory, filename)
	if info, err := os.Lstat(name); err != nil || !info.Mode().IsRegular() {
		return nil, nil
	}
	data, _ := readCache(name, limit)
	return data, nil
}

func (gallery *personalGallery) metadata(writer http.ResponseWriter, request *http.Request) error {
	data, err := gallery.readEntryFile(request.URL.Query().Get("id"), "metadata.json", personalGalleryMetadataLimit)
	if err != nil {
		return err
	}
	if !json.Valid(data) {
		data = []byte("null")
	}
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
	return nil
}

func (gallery *personalGallery) image(writer http.ResponseWriter, request *http.Request, id string) error {
	data, err := gallery.readEntryFile(id, "preview.jpg", personalGalleryPreviewLimit)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return personalGalleryRouteError(http.StatusNotFound, "图库中找不到这张小预览。")
	}
	writeBytes(writer, request, http.StatusOK, "image/jpeg", data)
	return nil
}

func (gallery *personalGallery) delete(writer http.ResponseWriter, request *http.Request) error {
	var payload struct {
		ID string `json:"id"`
	}
	if err := readPersonalGalleryPayload(request, &payload); err != nil {
		return err
	}
	gallery.mu.Lock()
	defer gallery.mu.Unlock()
	directory, err := gallery.entry(payload.ID)
	if err != nil {
		var route *routeError
		if errors.As(err, &route) && route.status == http.StatusNotFound {
			writePersonalGalleryJSON(writer, request, false)
			return nil
		}
		return err
	}
	trash, err := os.MkdirTemp(gallery.directory, ".removed-")
	if err != nil {
		return err
	}
	defer os.Remove(trash)
	removed := filepath.Join(trash, "entry")
	if err := os.Rename(directory, removed); err != nil {
		return err
	}
	gallery.index = nil
	removePersonalGalleryDirectory(removed)
	writePersonalGalleryJSON(writer, request, true)
	return nil
}
