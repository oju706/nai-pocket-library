package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	githubRawHost      = "raw.githubusercontent.com"
	packRegistryPath   = "https://" + githubRawHost + "/oju706/nai-pocket-library/main/resource-packs/galleries.json"
	packCatalogLimit   = 1024 * 1024
	packThumbnailLimit = 512 * 1024
	packOriginalLimit  = 12 * 1024 * 1024
	packCacheBudget    = 128 * 1024 * 1024
)

var (
	packIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	packSHA256    = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
	packSegment   = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
)

type onlinePackLibrary struct {
	cacheRoot string
	client    *http.Client
	downloads chan struct{}
	mu        sync.Mutex
	catalogs  map[string]*onlinePackCatalog
	revisions []string
}

type onlinePackCatalog struct {
	Title    string            `json:"title"`
	Revision string            `json:"revision"`
	Images   []onlinePackImage `json:"images"`
	byID     map[string]onlinePackPhoto
}

type onlinePackImage struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Model     string `json:"model"`
	Section   string `json:"section"`
	Rating    string `json:"rating"`
	Source    string `json:"source"`
	AddedOn   string `json:"addedOn,omitempty"`
	Bytes     int64  `json:"bytes"`
	Thumbnail string `json:"thumbnail"`
	Original  string `json:"original"`
}

type onlinePackPhoto struct {
	original  string
	thumbnail string
	digest    string
	bytes     int64
}

func newOnlinePackLibrary(cacheRoot string) *onlinePackLibrary {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = desktopUpstreamProxy
	transport.DisableCompression = true
	return &onlinePackLibrary{
		cacheRoot: filepath.Join(cacheRoot, "online-packs"),
		client: &http.Client{
			Transport: transport,
			Timeout:   22 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		downloads: make(chan struct{}, 4),
		catalogs:  make(map[string]*onlinePackCatalog),
	}
}

func validPackPath(value string) bool {
	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." || !packSegment.MatchString(segment) {
			return false
		}
	}
	return true
}

func packCatalogURL(address string) (*url.URL, error) {
	address = strings.TrimSpace(address)
	invalid := badRequest("请输入公开 GitHub 仓库地址或 online-pack.json 的 Raw 链接。")
	if address == "" || len(address) > 1024 {
		return nil, invalid
	}
	if !strings.Contains(address, "://") {
		address = "https://github.com/" + address
	}
	target, err := url.Parse(address)
	if err != nil || target.Scheme != "https" || target.User != nil ||
		target.RawQuery != "" || target.ForceQuery || target.Fragment != "" || target.RawPath != "" {
		return nil, invalid
	}
	switch target.Host {
	case "github.com":
		name := strings.TrimSuffix(strings.TrimPrefix(target.Path, "/"), "/")
		if !validPackPath(name) || strings.Count(name, "/") != 1 {
			return nil, invalid
		}
		target.Host = githubRawHost
		target.Path = "/" + name + "/main/online-pack.json"
	case githubRawHost:
		name := strings.TrimPrefix(target.Path, "/")
		if !validPackPath(name) || strings.Count(name, "/") < 3 || path.Base(name) != "online-pack.json" {
			return nil, invalid
		}
	default:
		return nil, invalid
	}
	return target, nil
}

func packImagePath(value string) bool {
	if len(value) > 500 || !validPackPath(value) {
		return false
	}
	switch strings.ToLower(path.Ext(value)) {
	case ".webp", ".png", ".jpg", ".jpeg":
		return true
	default:
		return false
	}
}

func (library *onlinePackLibrary) fetch(ctx context.Context, target string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "NAI-Pocket-Library-Desktop/"+appVersion)
	response, err := library.client.Do(request)
	if err != nil {
		return nil, upstreamFailure("暂时连不上 GitHub 图包。")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, notFound("GitHub 上没有这个公开目录或图片。")
	}
	if response.StatusCode != http.StatusOK {
		return nil, upstreamFailure(fmt.Sprintf("GitHub 图包返回 HTTP %d。", response.StatusCode))
	}
	encoding := response.Header.Get("Content-Encoding")
	if (encoding != "" && !strings.EqualFold(encoding, "identity")) || response.ContentLength > limit {
		return nil, upstreamFailure("GitHub 图包资源的大小或格式不符。")
	}
	data, err := readLimited(response.Body, limit)
	if err != nil {
		return nil, upstreamFailure("GitHub 图包资源读取失败。")
	}
	return data, nil
}

func packText(value, fallback string, limit int) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	for at := range value {
		if limit == 0 {
			return value[:at]
		}
		limit--
	}
	return value
}

func (library *onlinePackLibrary) catalog(ctx context.Context, address string) (*onlinePackCatalog, error) {
	target, err := packCatalogURL(address)
	if err != nil {
		return nil, err
	}
	raw, err := library.fetch(ctx, target.String(), packCatalogLimit)
	if err != nil {
		return nil, err
	}
	var input struct {
		Format  string `json:"format"`
		Version int    `json:"version"`
		Title   string `json:"title"`
		Images  []struct {
			onlinePackImage
			Digest string `json:"sha256"`
		} `json:"images"`
	}
	if err := json.Unmarshal(raw, &input); err != nil ||
		input.Format != "nai-pocket-online-pack" || input.Version != 1 || input.Images == nil || len(input.Images) > 2000 {
		return nil, upstreamFailure("GitHub 目录不是支持的在线图包格式。")
	}
	revision := cacheName(target.String(), sha256Hex(raw))
	title := packText(input.Title, "在线图包", 120)
	catalog := &onlinePackCatalog{Title: title, Revision: revision, Images: make([]onlinePackImage, 0, len(input.Images)),
		byID: make(map[string]onlinePackPhoto, len(input.Images))}
	base := target.ResolveReference(&url.URL{Path: "."})
	for index, row := range input.Images {
		item := row.onlinePackImage
		_, duplicate := catalog.byID[item.ID]
		if duplicate || !packIDPattern.MatchString(item.ID) || !packSHA256.MatchString(row.Digest) ||
			item.Bytes < 1 || item.Bytes > packOriginalLimit ||
			!packImagePath(item.Original) || !packImagePath(item.Thumbnail) {
			return nil, upstreamFailure(fmt.Sprintf("在线图包第 %d 张图片的路径、大小或校验值有误。", index+1))
		}
		catalog.byID[item.ID] = onlinePackPhoto{
			original:  base.ResolveReference(&url.URL{Path: item.Original}).String(),
			thumbnail: base.ResolveReference(&url.URL{Path: item.Thumbnail}).String(),
			bytes:     item.Bytes,
			digest:    strings.ToLower(row.Digest),
		}
		item.Title = packText(item.Title, item.ID, 200)
		item.Model = packText(item.Model, "未标注", 40)
		item.Source = packText(item.Source, title, 160)
		if item.Section != "character" && item.Section != "knowledge" {
			item.Section = "artist"
		}
		if item.Rating != "sfw" && item.Rating != "nsfw" {
			item.Rating = "unknown"
		}
		if _, err := time.Parse(time.DateOnly, item.AddedOn); err != nil {
			item.AddedOn = ""
		}
		item.Original = "/online-pack-image/" + revision + "/" + item.ID
		item.Thumbnail = "/online-pack-thumb/" + revision + "/" + item.ID
		catalog.Images = append(catalog.Images, item)
	}
	library.mu.Lock()
	if library.catalogs[revision] == nil {
		library.revisions = append(library.revisions, revision)
		if len(library.revisions) > 8 {
			delete(library.catalogs, library.revisions[0])
			library.revisions = library.revisions[1:]
		}
	}
	library.catalogs[revision] = catalog
	library.mu.Unlock()
	return catalog, nil
}

func (library *onlinePackLibrary) photoSize(revision, id string) int64 {
	library.mu.Lock()
	defer library.mu.Unlock()
	if catalog := library.catalogs[revision]; catalog != nil {
		return catalog.byID[id].bytes
	}
	return 0
}

func (library *onlinePackLibrary) photo(ctx context.Context, revision, id string, thumbnail bool) ([]byte, string, error) {
	library.mu.Lock()
	catalog := library.catalogs[revision]
	library.mu.Unlock()
	if catalog == nil {
		return nil, "", notFound("图包目录已变化，请重新打开。")
	}
	entry, ok := catalog.byID[id]
	if !ok {
		return nil, "", notFound("图包目录中没有这张图。")
	}
	target, limit, key := entry.original, entry.bytes, entry.digest
	if thumbnail {
		target, limit, key = entry.thumbnail, packThumbnailLimit, cacheName(revision, id, "thumb")
	}
	filename := filepath.Join(library.cacheRoot, key+".image")
	valid := func(data []byte) string {
		if !thumbnail && (int64(len(data)) != entry.bytes || sha256Hex(data) != entry.digest) {
			return ""
		}
		switch kind := imageType(data); kind {
		case "image/png", "image/webp", "image/jpeg":
			return kind
		}
		return ""
	}
	if cached, ok := readCache(filename, limit); ok {
		if kind := valid(cached); kind != "" {
			now := time.Now()
			_ = os.Chtimes(filename, now, now)
			return cached, kind, nil
		}
	}
	select {
	case library.downloads <- struct{}{}:
		defer func() { <-library.downloads }()
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	data, err := library.fetch(ctx, target, limit)
	if err != nil {
		return nil, "", err
	}
	kind := valid(data)
	if kind == "" {
		return nil, "", upstreamFailure("图包图片的格式或原图校验值不符，请检查图包更新。")
	}
	if writeCache(filename, data) == nil {
		pruneCache(library.cacheRoot, ".image", packCacheBudget)
	}
	return data, kind, nil
}

func (library *onlinePackLibrary) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "private, no-store")
	switch request.URL.Path {
	case "/api/gallery-packs.json":
		data, err := library.fetch(request.Context(), packRegistryPath, 64*1024)
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
	case "/api/online-pack.json":
		catalog, err := library.catalog(request.Context(), request.URL.Query().Get("address"))
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		data, _ := json.Marshal(catalog)
		writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", data)
	default:
		parts, err := pathSegments(request.URL.Path)
		if err != nil || len(parts) != 3 ||
			(parts[0] != "online-pack-image" && parts[0] != "online-pack-thumb") {
			writeRouteFailure(writer, request, notFound("图包图片不存在。"))
			return
		}
		data, kind, err := library.photo(request.Context(), parts[1], parts[2], parts[0] == "online-pack-thumb")
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		writeBytes(writer, request, http.StatusOK, kind, data)
	}
}
