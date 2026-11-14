package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	communityConfigURL = "https://raw.githubusercontent.com/oju706/nai-pocket-library/main/resource-packs/artist.json"

	communityCatalogRoute = "/api/remote-shared-style.json"
	communityPhotoRoute   = "/remote-shared-style-photo/"

	communityMaxArchiveBytes   = int64(2 * 1024 * 1024 * 1024)
	communityMaxRangeBytes     = int64(12 * 1024 * 1024)
	communityReadWindowBytes   = int64(32 * 1024)
	communityMaxManifestBytes  = int64(4 * 1024 * 1024)
	communityMaxImageBytes     = int64(12 * 1024 * 1024)
	communityMaxEntries        = 10000
	communityMaxArchiveName    = 1024
	communityMaxRedirects      = 4
	communityMaxManifestImages = 10000
)

var (
	communityImageIDPattern     = regexp.MustCompile(`^[0-9]{1,16}$`)
	communityImageDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
	communityCommitPattern      = regexp.MustCompile(`^[a-f0-9]{40}$`)
	communityImageNamePattern   = regexp.MustCompile(`^[a-f0-9]{64}\.webp$`)
	communityImageEntryPattern  = regexp.MustCompile(`^arca_style_images/[a-f0-9]{64}\.webp$`)
	communityRangePattern       = regexp.MustCompile(`^bytes ([0-9]+)-([0-9]+)/([0-9]+)$`)
	communityArchiveURLPattern  = regexp.MustCompile(`^https://huggingface\.co/datasets/okawaritsuika/` +
		`nai-shared-styles/resolve/([a-f0-9]{40})/NAImakeArtistGroup_shared_images_[0-9]{8}_webp\.zip$`)
	communityAllowedRedirectHost = "us.aws.cdn.hf.co"
)

type communityZip struct {
	client    *http.Client
	webRoot   string
	cacheRoot string
	downloads chan struct{}
	refresh   sync.Mutex
	mu        sync.RWMutex
	current   *communityIndex
}

type communityConfig struct {
	Format         string `json:"format"`
	Version        int    `json:"version"`
	Section        string `json:"section"`
	Kind           string `json:"kind"`
	Source         string `json:"source"`
	Bytes          int64  `json:"bytes"`
	ManifestSHA256 string `json:"manifestSha256"`
	Release        string `json:"release"`
}

type communityIndex struct {
	config   communityConfig
	revision string
	catalog  []byte
	photos   map[string]*communityPhoto
}

type communityPhoto struct {
	id      string
	source  string
	postID  string
	bytes   int64
	sha256  string
	archive *zip.File
}

type communityManifest struct {
	Format    string                  `json:"format"`
	Version   int                     `json:"version"`
	FileCount int                     `json:"file_count"`
	Files     []communityManifestFile `json:"files"`
}

type communityManifestFile struct {
	ImageID   json.RawMessage `json:"image_id"`
	Name      string          `json:"name"`
	SHA256    string          `json:"sha256"`
	SourceURL string          `json:"source_url"`
	Bytes     int64           `json:"bytes"`
}

func communityImageID(value json.RawMessage) string {
	if len(value) > 0 && value[0] == '"' {
		var id string
		if json.Unmarshal(value, &id) == nil {
			return id
		}
		return ""
	}
	return string(value)
}

type communityCatalogDocument struct {
	Title       string                  `json:"title"`
	Revision    string                  `json:"revision"`
	BatchDate   string                  `json:"batchDate"`
	DownloadURL string                  `json:"downloadUrl"`
	Images      []communityCatalogImage `json:"images"`
}

type communityCatalogImage struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Section   string `json:"section"`
	Rating    string `json:"rating"`
	Model     string `json:"model"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
	Source    string `json:"source"`
	PostID    string `json:"postId"`
	Thumbnail string `json:"thumbnail"`
	Original  string `json:"original"`
}

// newCommunityZip creates the fixed, read-only Arca community style archive source.
func newCommunityZip(webRoot, cacheRoot string) *communityZip {
	transport := &http.Transport{
		Proxy:                 desktopUpstreamProxy,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
		MaxIdleConns:          8,
		MaxIdleConnsPerHost:   4,
	}
	return &communityZip{
		webRoot:   webRoot,
		cacheRoot: filepath.Join(cacheRoot, "community-packs"),
		downloads: make(chan struct{}, 4),
		client: &http.Client{
			Transport: transport,
			Timeout:   50 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (library *communityZip) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		writeAPIFailure(writer, request, http.StatusMethodNotAllowed, "仅支持 GET 和 HEAD")
		return
	}

	switch {
	case request.URL.Path == communityCatalogRoute:
		library.serveCatalog(writer, request)
	case strings.HasPrefix(request.URL.Path, communityPhotoRoute):
		library.servePhoto(writer, request)
	default:
		writeAPIFailure(writer, request, http.StatusNotFound, "接口不存在")
	}
}

func (library *communityZip) serveCatalog(writer http.ResponseWriter, request *http.Request) {
	index, err := library.load(request.Context(), request.URL.Query().Get("check") == "1")
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeBytes(writer, request, http.StatusOK, "application/json; charset=utf-8", index.catalog)
}

func (library *communityZip) servePhoto(writer http.ResponseWriter, request *http.Request) {
	parts, err := pathSegments(request.URL.Path)
	if err != nil || len(parts) != 4 || !packSHA256.MatchString(parts[1]) ||
		!communityImageIDPattern.MatchString(parts[2]) || (parts[3] != "thumb" && parts[3] != "original") {
		writeRouteFailure(writer, request, notFound("图片不存在。"))
		return
	}
	data, mime, err := library.photo(request.Context(), parts[1], parts[2], parts[3] == "thumb")
	if err != nil {
		writeRouteFailure(writer, request, err)
		return
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writeBytes(writer, request, http.StatusOK, mime, data)
}

func (library *communityZip) index() *communityIndex {
	library.mu.RLock()
	defer library.mu.RUnlock()
	return library.current
}

func (library *communityZip) photoSize(revision, id string) int64 {
	index := library.index()
	if index != nil && index.revision == revision {
		if photo := index.photos[id]; photo != nil {
			return photo.bytes
		}
	}
	return 0
}

func (library *communityZip) photo(ctx context.Context, revision, id string, _ bool) ([]byte, string, error) {
	index := library.index()
	if index == nil || index.revision != revision || index.photos[id] == nil {
		return nil, "", notFound("图包目录已变化，请重新打开。")
	}
	photo := index.photos[id]
	filename := filepath.Join(library.cacheRoot, photo.sha256+".image")
	if data, ok := readCache(filename, photo.bytes); ok && int64(len(data)) == photo.bytes &&
		imageType(data) == "image/webp" && sha256Hex(data) == photo.sha256 {
		now := time.Now()
		_ = os.Chtimes(filename, now, now)
		return data, "image/webp", nil
	}
	select {
	case library.downloads <- struct{}{}:
		defer func() { <-library.downloads }()
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	data, err := readCommunityEntry(photo.archive, photo.bytes, photo.sha256)
	if err != nil || imageType(data) != "image/webp" {
		logError("社区画风图片读取失败", id, communityReadError(err))
		return nil, "", upstreamFailure("社区画风图片暂时无法读取。")
	}
	if writeCache(filename, data) == nil {
		pruneCache(library.cacheRoot, ".image", packCacheBudget)
	}
	return data, "image/webp", nil
}

func communityReadError(err error) error {
	var requestError *url.Error
	if errors.As(err, &requestError) {
		return requestError.Err
	}
	return err
}

func (library *communityZip) load(ctx context.Context, check bool) (*communityIndex, error) {
	if current := library.index(); current != nil && !check {
		return current, nil
	}
	library.refresh.Lock()
	defer library.refresh.Unlock()
	previous := library.index()
	if previous != nil && !check {
		return previous, nil
	}
	config, err := library.readConfig(ctx)
	if err != nil {
		return nil, err
	}
	if previous != nil && previous.config == config {
		return previous, nil
	}
	matches := communityArchiveURLPattern.FindStringSubmatch(config.Source)
	source, err := newCommunityArchiveSource(library.client, config.Bytes, config.Source, matches[1])
	if err != nil {
		return nil, upstreamFailure("社区图包配置无效。")
	}
	models := library.readModels(config.ManifestSHA256)
	var batchDate string
	if date, err := time.Parse("20060102", config.Release); err == nil {
		batchDate = date.Format(time.DateOnly)
	}
	index, err := loadCommunityArchive(source, config, models, batchDate)
	if err != nil {
		logError("社区画风在线目录读取失败", matches[1], communityReadError(err))
		return nil, upstreamFailure("社区画风目录暂时无法读取。")
	}
	library.mu.Lock()
	library.current = index
	library.mu.Unlock()
	return index, nil
}

func (library *communityZip) readConfig(ctx context.Context) (communityConfig, error) {
	var config communityConfig
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, communityConfigURL, nil)
	if err != nil {
		return config, err
	}
	request.Header.Set("Accept-Encoding", "identity")
	response, err := library.client.Do(request)
	if err != nil {
		return config, upstreamFailure("暂时无法读取 GitHub 上的社区图包配置。")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return config, upstreamFailure("GitHub 上的社区图包配置暂时不可用。")
	}
	raw, err := readLimited(response.Body, 16*1024)
	if err != nil || json.Unmarshal(raw, &config) != nil ||
		config.Format != "nai-pocket-resource-pack" || config.Version != 1 ||
		config.Section != "artist" || config.Kind != "shared-style-zip" ||
		!communityImageDigestPattern.MatchString(config.ManifestSHA256) ||
		!communityArchiveURLPattern.MatchString(config.Source) {
		return config, upstreamFailure("社区图包配置无效。")
	}
	return config, nil
}

func (library *communityZip) readModels(digest string) map[string]string {
	raw, ok := readCache(filepath.Join(library.webRoot, "community-style-models.json"), 256*1024)
	if !ok {
		return nil
	}
	var data struct {
		Format         string            `json:"format"`
		Version        int               `json:"version"`
		ManifestSHA256 string            `json:"manifestSha256"`
		Models         map[string]string `json:"models"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Format != "nai-pocket-community-models" ||
		data.Version != 1 || data.ManifestSHA256 != digest {
		return nil
	}
	return data.Models
}

func loadCommunityArchive(source *communityArchiveSource, config communityConfig, models map[string]string, batchDate string) (*communityIndex, error) {
	manifestSHA := config.ManifestSHA256
	if source == nil || !communityArchiveSourceConfigValid(source.total, source.sourceURL, source.sourceCommit) ||
		!communityImageDigestPattern.MatchString(manifestSHA) {
		return nil, errResourceTooLarge
	}
	archive, err := zip.NewReader(source, source.total)
	if err != nil {
		return nil, err
	}
	if len(archive.File) == 0 || len(archive.File) > communityMaxEntries {
		return nil, errResourceTooLarge
	}

	files := make(map[string]*zip.File, len(archive.File))
	var manifest *zip.File
	for _, file := range archive.File {
		if !communitySafeArchiveName(file.Name) || files[file.Name] != nil {
			return nil, errors.New("invalid archive entry name")
		}
		files[file.Name] = file
		if file.FileInfo().IsDir() {
			continue
		}
		switch {
		case file.Name == "manifest.json":
			manifest = file
		case communityImageEntryPattern.MatchString(file.Name):
		default:
			return nil, errors.New("unexpected archive entry")
		}
		if file.Flags&^uint16(0x080e) != 0 ||
			(file.Method != zip.Store && file.Method != zip.Deflate) {
			return nil, errors.New("unsupported archive entry")
		}
		limit := communityMaxImageBytes
		if file.Name == "manifest.json" {
			limit = communityMaxManifestBytes
		}
		if file.UncompressedSize64 > uint64(limit) ||
			file.CompressedSize64 > uint64(limit+65536) ||
			(file.Method == zip.Store && file.CompressedSize64 != file.UncompressedSize64) {
			return nil, errResourceTooLarge
		}
	}
	if manifest == nil {
		return nil, errors.New("manifest.json is missing")
	}

	rawManifest, err := readCommunityEntry(manifest, communityMaxManifestBytes, manifestSHA)
	if err != nil {
		return nil, err
	}
	var document communityManifest
	if err := json.Unmarshal(rawManifest, &document); err != nil {
		return nil, err
	}
	if document.Format != "naimakeartistgroup-shared-images" || document.Version != 2 ||
		document.FileCount < 1 || document.FileCount > communityMaxManifestImages ||
		len(document.Files) != document.FileCount {
		return nil, errors.New("unsupported community manifest")
	}

	photos := make(map[string]*communityPhoto, len(document.Files))
	images := make([]communityCatalogImage, 0, len(document.Files))
	revisionHash := sha256.Sum256([]byte(source.sourceURL + "\n" + manifestSHA))
	revision := hex.EncodeToString(revisionHash[:])
	for index, row := range document.Files {
		id := communityImageID(row.ImageID)
		if !communityImageIDPattern.MatchString(id) ||
			!communityImageDigestPattern.MatchString(row.SHA256) ||
			!communityImageNamePattern.MatchString(row.Name) ||
			!strings.HasPrefix(row.SourceURL, "https://arca.live/b/aiart/") {
			return nil, fmt.Errorf("invalid manifest row %d", index+1)
		}
		postID := strings.TrimPrefix(row.SourceURL, "https://arca.live/b/aiart/")
		if !communityImageIDPattern.MatchString(postID) ||
			row.Bytes < 12 || row.Bytes > communityMaxImageBytes ||
			photos[id] != nil {
			return nil, fmt.Errorf("invalid manifest row %d", index+1)
		}
		entry := files["arca_style_images/"+row.Name]
		if entry == nil || entry.UncompressedSize64 != uint64(row.Bytes) {
			return nil, fmt.Errorf("missing image entry %d", index+1)
		}
		photo := &communityPhoto{
			id:      id,
			source:  row.SourceURL,
			postID:  postID,
			bytes:   row.Bytes,
			sha256:  row.SHA256,
			archive: entry,
		}
		photos[photo.id] = photo
		images = append(images, communityCatalogImage{
			ID:        photo.id,
			Title:     "原帖 " + photo.postID + " · 图 " + photo.id,
			Section:   "artist",
			Rating:    "unknown",
			Model:     packText(models[photo.id], "未标注", 80),
			Bytes:     photo.bytes,
			SHA256:    photo.sha256,
			Source:    photo.source,
			PostID:    photo.postID,
			Thumbnail: communityPhotoRoute + revision + "/" + photo.id + "/thumb",
			Original:  communityPhotoRoute + revision + "/" + photo.id + "/original",
		})
	}
	if len(photos) == 0 {
		return nil, errors.New("empty community manifest")
	}

	catalog, err := json.Marshal(communityCatalogDocument{
		Title:       "Arca Live 社区画风合集",
		Revision:    revision,
		BatchDate:   batchDate,
		DownloadURL: source.sourceURL,
		Images:      images,
	})
	if err != nil {
		return nil, err
	}
	return &communityIndex{config: config, photos: photos, revision: revision, catalog: catalog}, nil
}

func readCommunityEntry(entry *zip.File, limit int64, expectedSHA string) ([]byte, error) {
	if entry == nil || limit < 0 || entry.UncompressedSize64 > uint64(limit) ||
		!communityImageDigestPattern.MatchString(expectedSHA) {
		return nil, errResourceTooLarge
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	data, err := readLimited(reader, limit)
	closeErr := reader.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if int64(len(data)) != int64(entry.UncompressedSize64) ||
		crc32.ChecksumIEEE(data) != entry.CRC32 ||
		sha256Hex(data) != expectedSHA {
		return nil, errors.New("community entry verification failed")
	}
	return data, nil
}

func communitySafeArchiveName(name string) bool {
	if name == "" || len(name) > communityMaxArchiveName || strings.ContainsAny(name, "\\\x00") {
		return false
	}
	trimmed := strings.TrimSuffix(name, "/")
	if trimmed == "" {
		return false
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
		for _, character := range part {
			if !((character >= 'a' && character <= 'z') ||
				(character >= 'A' && character <= 'Z') ||
				(character >= '0' && character <= '9') ||
				character == '_' || character == '.' || character == '-') {
				return false
			}
		}
	}
	return true
}

type communityArchiveSource struct {
	client       *http.Client
	total        int64
	sourceURL    string
	sourceCommit string

	mu           sync.Mutex
	cachedOffset int64
	cached       []byte
}

func newCommunityArchiveSource(client *http.Client, total int64, sourceURL string, sourceCommit string) (*communityArchiveSource, error) {
	if client == nil || !communityArchiveSourceConfigValid(total, sourceURL, sourceCommit) {
		return nil, errors.New("invalid community archive source")
	}
	return &communityArchiveSource{
		client:       client,
		total:        total,
		sourceURL:    sourceURL,
		sourceCommit: sourceCommit,
	}, nil
}

func communityArchiveSourceConfigValid(total int64, sourceURL string, sourceCommit string) bool {
	match := communityArchiveURLPattern.FindStringSubmatch(sourceURL)
	return total >= 22 && total <= communityMaxArchiveBytes &&
		communityCommitPattern.MatchString(sourceCommit) &&
		len(match) == 2 && match[1] == sourceCommit
}

func (source *communityArchiveSource) ReadAt(buffer []byte, offset int64) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if source == nil || source.client == nil || offset < 0 || int64(len(buffer)) > communityMaxRangeBytes ||
		offset > source.total || int64(len(buffer)) > source.total-offset {
		return 0, io.EOF
	}

	source.mu.Lock()
	defer source.mu.Unlock()
	if offset >= source.cachedOffset &&
		offset+int64(len(buffer)) <= source.cachedOffset+int64(len(source.cached)) {
		start := offset - source.cachedOffset
		copy(buffer, source.cached[start:start+int64(len(buffer))])
		return len(buffer), nil
	}

	length := int64(len(buffer))
	if length < communityReadWindowBytes {
		length = communityReadWindowBytes
		if remaining := source.total - offset; remaining < length {
			length = remaining
		}
	}
	data, err := source.fetchRange(offset, length)
	if err != nil {
		return 0, err
	}
	if int64(len(buffer)) > int64(len(data)) {
		return 0, io.EOF
	}
	source.cachedOffset = offset
	source.cached = data
	copy(buffer, data[:len(buffer)])
	return len(buffer), nil
}

func (source *communityArchiveSource) fetchRange(offset, length int64) ([]byte, error) {
	if source == nil || source.client == nil || offset < 0 || length < 1 ||
		length > communityMaxRangeBytes || offset > source.total ||
		length > source.total-offset ||
		!communityArchiveSourceConfigValid(source.total, source.sourceURL, source.sourceCommit) {
		return nil, errors.New("invalid community range")
	}
	last := offset + length - 1
	expectedRange := fmt.Sprintf("bytes %d-%d/%d", offset, last, source.total)
	current, err := url.Parse(source.sourceURL)
	if err != nil {
		return nil, err
	}
	for redirects := 0; redirects <= communityMaxRedirects; redirects++ {
		if !communityAllowedSourceURL(current, redirects, source.sourceURL) {
			return nil, errors.New("unexpected community source host")
		}
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, current.String(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, last))
		request.Header.Set("Accept-Encoding", "identity")
		request.Header.Set("User-Agent", "NAI-Pocket-Library-Desktop/"+appVersion)

		response, err := source.client.Do(request)
		if err != nil {
			return nil, err
		}
		if redirects == 0 {
			if response.Header.Get("X-Repo-Commit") != source.sourceCommit {
				response.Body.Close()
				return nil, errors.New("community source revision changed")
			}
			if linkedSize := strings.TrimSpace(response.Header.Get("X-Linked-Size")); linkedSize != "" &&
				linkedSize != strconv.FormatInt(source.total, 10) {
				response.Body.Close()
				return nil, errors.New("community source size changed")
			}
		}
		if response.StatusCode >= 300 && response.StatusCode <= 399 {
			location := response.Header.Get("Location")
			response.Body.Close()
			if redirects == communityMaxRedirects {
				return nil, errors.New("too many community redirects")
			}
			next, err := safeRedirectTarget(current, location)
			if err != nil || !communityAllowedSourceURL(next, redirects+1, source.sourceURL) {
				return nil, errors.New("invalid community redirect")
			}
			current = next
			continue
		}
		if response.StatusCode != http.StatusPartialContent {
			response.Body.Close()
			return nil, errors.New("community source ignored range request")
		}
		if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" &&
			!strings.EqualFold(encoding, "identity") {
			response.Body.Close()
			return nil, errors.New("unexpected community content encoding")
		}
		if response.Header.Get("Content-Range") != expectedRange {
			response.Body.Close()
			return nil, errors.New("community source returned a different range")
		}
		if response.ContentLength >= 0 && response.ContentLength != length {
			response.Body.Close()
			return nil, errors.New("community source returned a different length")
		}
		data, readErr := readLimited(response.Body, length)
		response.Body.Close()
		if readErr != nil || int64(len(data)) != length {
			return nil, errors.New("incomplete community range")
		}
		return data, nil
	}
	return nil, errors.New("too many community redirects")
}

func communityAllowedSourceURL(target *url.URL, redirects int, sourceURL string) bool {
	if target == nil || target.Scheme != "https" || target.User != nil ||
		target.Fragment != "" || target.RawFragment != "" ||
		(target.Port() != "" && target.Port() != "443") {
		return false
	}
	if redirects == 0 {
		return target.String() == sourceURL
	}
	return target.Hostname() == communityAllowedRedirectHost
}

var _ http.Handler = (*communityZip)(nil)
var _ io.ReaderAt = (*communityArchiveSource)(nil)
