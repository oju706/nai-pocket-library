package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	naxCatalogURL       = "https://nax.moe/downloads/tags.zip"
	naxArchiveLimit     = int64(3 * 1024 * 1024)
	naxArchiveJSONLimit = int64(20 * 1024 * 1024)
	naxCatalogLimit     = int64(16 * 1024 * 1024)
	naxCatalogMetaLimit = int64(16 * 1024)
	naxImageLimit       = int64(6 * 1024 * 1024)
	naxImageCacheBudget = int64(32 * 1024 * 1024)
	naxImageCacheSuffix = ".webp"
)

var naxGalleries = map[string]struct{}{
	"danbooru-artist-tags-2-v5":      {},
	"danbooru-artist-tags-v5":        {},
	"danbooru-artist-tags-male-2-v5": {},
	"danbooru-artist-tags-2-v4.5":    {},
	"danbooru-artist-tags-v4.5":      {},
	"artists-v4.5":                   {},
	"danbooru-character-tags-v5":     {},
	"danbooru-character-tags-v4.5":   {},
	"danbooru-hair-tags-v5":          {},
	"danbooru-hair-tags-v4.5":        {},
	"danbooru-face-tags-v4.5":        {},
}

type naxLibrary struct {
	cacheRoot          string
	client             *http.Client
	downloads          chan struct{}
	mu                 sync.Mutex
	initialized        bool
	catalogData        []byte
	catalogFingerprint string
	catalogETag        string
	catalogModified    string
}

type naxCatalogResult struct {
	data     []byte
	status   string
	revision string
}

type naxCacheMeta struct {
	ETag         string `json:"etag"`
	LastModified string `json:"lastModified"`
	Fingerprint  string `json:"fingerprint"`
}

type naxDownload struct {
	data        []byte
	etag        string
	modified    string
	notModified bool
}

type naxTag struct {
	Tag      string `json:"tag"`
	Filename string `json:"filename"`
}

func newNAXLibrary(cacheRoot string) *naxLibrary {
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
	return &naxLibrary{
		cacheRoot: cacheRoot,
		client: &http.Client{
			Transport: transport,
			Timeout:   50 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		downloads: make(chan struct{}, 3),
	}
}

func (library *naxLibrary) authorize(gallery, filename string) error {
	if !validNAXGallery(gallery) || !validNAXFilename(filename) {
		return notFound("图片不存在")
	}
	return nil
}

func (library *naxLibrary) catalog(ctx context.Context, check bool) (naxCatalogResult, error) {
	library.mu.Lock()
	defer library.mu.Unlock()

	catalogPath := filepath.Join(library.cacheRoot, "nax", "catalog.json")
	metaPath := filepath.Join(library.cacheRoot, "nax", "catalog-meta.json")
	if !library.initialized {
		cached, ok := readCache(catalogPath, naxCatalogLimit)
		if ok && validNAXCatalog(cached) {
			library.catalogData = cached
			library.catalogFingerprint = sha256Hex(cached)
			if meta, metaOK := readNAXMeta(metaPath); metaOK && meta.Fingerprint == library.catalogFingerprint {
				library.catalogETag = meta.ETag
				library.catalogModified = meta.LastModified
			}
		}
		library.initialized = true
	}
	cached := library.catalogData
	hasCached := len(cached) != 0
	fingerprint := library.catalogFingerprint
	if hasCached && !check {
		return naxCatalogResult{
			data:     cached,
			status:   "cached",
			revision: shortFingerprint(fingerprint),
		}, nil
	}

	etag, modified := library.catalogETag, library.catalogModified
	download, err := library.download(ctx, naxCatalogURL, naxArchiveLimit, etag, modified)
	if err != nil {
		return naxCatalogResult{}, upstreamFailure("NAX 目录暂时无法读取")
	}
	if download.notModified {
		if !hasCached {
			return naxCatalogResult{}, upstreamFailure("NAX 目录缓存缺失")
		}
		return naxCatalogResult{
			data:     cached,
			status:   "current",
			revision: shortFingerprint(fingerprint),
		}, nil
	}
	filtered, err := filterNAXArchive(download.data)
	if err != nil {
		return naxCatalogResult{}, upstreamFailure("NAX 目录格式无效")
	}
	newFingerprint := sha256Hex(filtered)
	status := "downloaded"
	if hasCached {
		if newFingerprint == fingerprint {
			status = "current"
		} else {
			status = "updated"
		}
	}
	if !hasCached || newFingerprint != fingerprint {
		if err := writeCache(catalogPath, filtered); err != nil {
			return naxCatalogResult{}, unavailable("NAX 目录无法写入本地缓存")
		}
	}
	library.catalogData = filtered
	library.catalogFingerprint = newFingerprint
	library.catalogETag = download.etag
	library.catalogModified = download.modified
	newMeta := naxCacheMeta{
		ETag:         download.etag,
		LastModified: download.modified,
		Fingerprint:  newFingerprint,
	}
	if validHeaderCacheValue(newMeta.ETag, 1024) && validHeaderCacheValue(newMeta.LastModified, 256) {
		if metadata, err := json.Marshal(newMeta); err == nil {
			_ = writeCache(metaPath, metadata)
		}
	}
	return naxCatalogResult{
		data:     filtered,
		status:   status,
		revision: shortFingerprint(newFingerprint),
	}, nil
}

func (library *naxLibrary) image(ctx context.Context, gallery, filename string) ([]byte, error) {
	if err := library.authorize(gallery, filename); err != nil {
		return nil, err
	}
	imagePath := filepath.Join(library.cacheRoot, "nax", "images", cacheName(gallery, filename)+naxImageCacheSuffix)
	if cached, ok := readCache(imagePath, naxImageLimit); ok && imageType(cached) == "image/webp" {
		_ = os.Chtimes(imagePath, time.Now(), time.Now())
		return cached, nil
	}

	select {
	case library.downloads <- struct{}{}:
		defer func() { <-library.downloads }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if cached, ok := readCache(imagePath, naxImageLimit); ok && imageType(cached) == "image/webp" {
		return cached, nil
	}

	source := (&url.URL{
		Scheme: "https",
		Host:   "cdn.zele.st",
		Path:   "/data/NAX/Images/" + gallery + "/" + filename,
	}).String()
	download, err := library.download(ctx, source, naxImageLimit, "", "")
	if err != nil || download.notModified || imageType(download.data) != "image/webp" {
		return nil, upstreamFailure("NAX 图片暂时无法读取")
	}
	if err := writeCache(imagePath, download.data); err == nil {
		pruneCache(filepath.Dir(imagePath), naxImageCacheSuffix, naxImageCacheBudget)
	}
	return download.data, nil
}

func (library *naxLibrary) download(ctx context.Context, source string, limit int64, etag, modified string) (naxDownload, error) {
	current, err := url.Parse(source)
	if err != nil {
		return naxDownload{}, err
	}
	useConditional := validHeaderCacheValue(etag, 1024) && etag != "" ||
		validHeaderCacheValue(modified, 256) && modified != ""
	for redirects := 0; redirects <= 4; redirects++ {
		if !allowedNAXURL(current) {
			return naxDownload{}, errors.New("unexpected download host")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, current.String(), nil)
		if err != nil {
			return naxDownload{}, err
		}
		request.Header.Set("Accept-Encoding", "identity")
		request.Header.Set("User-Agent", "NAI-Pocket-Library-Desktop/"+appVersion)
		if validHeaderCacheValue(etag, 1024) && etag != "" {
			request.Header.Set("If-None-Match", etag)
		}
		if validHeaderCacheValue(modified, 256) && modified != "" {
			request.Header.Set("If-Modified-Since", modified)
		}

		response, err := library.client.Do(request)
		if err != nil {
			return naxDownload{}, err
		}
		if response.StatusCode >= 300 && response.StatusCode <= 399 {
			location := response.Header.Get("Location")
			response.Body.Close()
			if redirects == 4 {
				return naxDownload{}, errors.New("too many redirects")
			}
			next, err := safeRedirectTarget(current, location)
			if err != nil {
				return naxDownload{}, err
			}
			current = next
			continue
		}
		if response.StatusCode == http.StatusNotModified {
			response.Body.Close()
			if !useConditional {
				return naxDownload{}, errors.New("unexpected not-modified response")
			}
			return naxDownload{
				etag:        etag,
				modified:    modified,
				notModified: true,
			}, nil
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return naxDownload{}, errors.New("download unavailable")
		}
		if response.ContentLength > limit {
			response.Body.Close()
			return naxDownload{}, errResourceTooLarge
		}
		data, readErr := readLimited(response.Body, limit)
		response.Body.Close()
		if readErr != nil {
			return naxDownload{}, readErr
		}
		responseETag := strings.TrimSpace(response.Header.Get("ETag"))
		lastModified := strings.TrimSpace(response.Header.Get("Last-Modified"))
		if !validHeaderCacheValue(responseETag, 1024) {
			responseETag = ""
		}
		if !validHeaderCacheValue(lastModified, 256) {
			lastModified = ""
		}
		return naxDownload{
			data:     data,
			etag:     responseETag,
			modified: lastModified,
		}, nil
	}
	return naxDownload{}, errors.New("too many redirects")
}

func allowedNAXURL(target *url.URL) bool {
	if target == nil || target.Scheme != "https" || target.User != nil ||
		target.Fragment != "" || target.RawFragment != "" {
		return false
	}
	if target.Port() != "" && target.Port() != "443" {
		return false
	}
	switch target.Hostname() {
	case "nax.moe", "www.nax.moe", "cdn.zele.st":
		return true
	default:
		return false
	}
}

func filterNAXArchive(archive []byte) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, err
	}
	for _, entry := range reader.File {
		if entry.Name != "tags.json" {
			continue
		}
		if entry.UncompressedSize64 > uint64(naxArchiveJSONLimit) {
			return nil, errResourceTooLarge
		}
		stream, err := entry.Open()
		if err != nil {
			return nil, err
		}
		data, err := readLimited(stream, naxArchiveJSONLimit)
		stream.Close()
		if err != nil {
			return nil, err
		}
		var source struct {
			Galleries map[string]struct {
				Tags []naxTag `json:"tags"`
			} `json:"galleries"`
		}
		if err := json.Unmarshal(data, &source); err != nil {
			return nil, err
		}
		catalog := make(map[string][][2]string)
		count := 0
		for gallery, value := range source.Galleries {
			if _, known := naxGalleries[gallery]; !known {
				continue
			}
			items := make([][2]string, 0, len(value.Tags))
			for _, tag := range value.Tags {
				if !validNAXTag(tag.Tag) || !validNAXFilename(tag.Filename) {
					continue
				}
				items = append(items, [2]string{tag.Tag, tag.Filename})
				count++
			}
			if len(items) != 0 {
				catalog[gallery] = items
			}
		}
		if count == 0 {
			return nil, errors.New("empty NAX catalog")
		}
		filtered, err := json.Marshal(catalog)
		if err != nil || int64(len(filtered)) > naxCatalogLimit {
			return nil, errResourceTooLarge
		}
		return filtered, nil
	}
	return nil, errors.New("NAX catalog entry missing")
}

func validNAXCatalog(data []byte) bool {
	if len(data) == 0 || int64(len(data)) > naxCatalogLimit {
		return false
	}
	var catalog map[string][][2]string
	if json.Unmarshal(data, &catalog) != nil || len(catalog) == 0 {
		return false
	}
	for gallery, entries := range catalog {
		if !validNAXGallery(gallery) || len(entries) == 0 {
			return false
		}
		for _, entry := range entries {
			if !validNAXTag(entry[0]) || !validNAXFilename(entry[1]) {
				return false
			}
		}
	}
	return true
}

func readNAXMeta(filename string) (naxCacheMeta, bool) {
	data, ok := readCache(filename, naxCatalogMetaLimit)
	if !ok {
		return naxCacheMeta{}, false
	}
	var meta naxCacheMeta
	if json.Unmarshal(data, &meta) != nil ||
		!validHeaderCacheValue(meta.ETag, 1024) ||
		!validHeaderCacheValue(meta.LastModified, 256) ||
		len(meta.Fingerprint) != sha256.Size*2 {
		return naxCacheMeta{}, false
	}
	if _, err := hex.DecodeString(meta.Fingerprint); err != nil {
		return naxCacheMeta{}, false
	}
	return meta, true
}

func validNAXGallery(gallery string) bool {
	_, ok := naxGalleries[gallery]
	return ok
}

func validNAXTag(tag string) bool {
	return tag != "" && utf8.RuneCountInString(tag) <= 400 && !strings.ContainsRune(tag, '\x00')
}

func validNAXFilename(filename string) bool {
	length := utf8.RuneCountInString(filename)
	if length < 6 || length > 512 || !strings.HasSuffix(filename, ".webp") {
		return false
	}
	for _, character := range filename {
		if character == '/' || character == '\\' || unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func shortFingerprint(fingerprint string) string {
	if len(fingerprint) >= 16 {
		return fingerprint[:16]
	}
	return fingerprint
}
