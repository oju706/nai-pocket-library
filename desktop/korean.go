package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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
	"unicode/utf8"
)

const (
	koreanSourceRoot     = "https://huggingface.co/baqu2213/PoemForSmallFThings/resolve/"
	koreanRelease        = "3f9a156edc9cee75f579bd25a22ee98ab47dec52"
	koreanIndexLimit     = 4 * 1024 * 1024
	koreanImageLimit     = 6 * 1024 * 1024
	koreanCacheBudget    = int64(64 * 1024 * 1024)
	koreanImageCacheName = ".image"
)

var (
	koreanETagPattern  = regexp.MustCompile(`^"[a-fA-F0-9]{64}"$`)
	koreanRangePattern = regexp.MustCompile(`^bytes ([0-9]+)-([0-9]+)/([0-9]+)$`)
)

type koreanLibrary struct {
	webRoot   string
	cacheRoot string
	client    *http.Client
	downloads chan struct{}

	mu    sync.Mutex
	packs map[string]*koreanPack
}

type koreanPack struct {
	id        string
	filename  string
	sourceURL string
	bytes     int64
	etag      string
	identity  string
	json      []byte
	spans     map[koreanSpan]struct{}
}

type koreanSpan struct {
	offset int64
	size   int
}

type koreanIndexDocument struct {
	Format  string            `json:"format"`
	Version int               `json:"version"`
	Source  koreanIndexSource `json:"source"`
	Artists []json.RawMessage `json:"artists"`
}

type koreanIndexSource struct {
	ID    string `json:"id"`
	URL   string `json:"url"`
	Bytes int64  `json:"bytes"`
	ETag  string `json:"etag"`
}

type koreanStatus struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Checked bool   `json:"checked"`
}

func newKoreanLibrary(webRoot, cacheRoot string) *koreanLibrary {
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
	return &koreanLibrary{
		webRoot:   webRoot,
		cacheRoot: cacheRoot,
		client: &http.Client{
			Transport: transport,
			Timeout:   50 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		downloads: make(chan struct{}, 3),
		packs:     make(map[string]*koreanPack),
	}
}

func (library *koreanLibrary) catalog(packID string) ([]byte, error) {
	pack, err := library.load(packID)
	if err != nil {
		return nil, err
	}
	return pack.json, nil
}

func (library *koreanLibrary) authorize(packID string, offset int64, size int) error {
	pack, err := library.load(packID)
	if err != nil {
		return err
	}
	if _, ok := pack.spans[koreanSpan{offset: offset, size: size}]; !ok {
		return notFound("图片不在内置索引中")
	}
	return nil
}

func (library *koreanLibrary) status(ctx context.Context, packID string, check bool) koreanStatus {
	pack, err := library.load(packID)
	if err != nil {
		return koreanStatus{
			Status:  "failed",
			Message: "韩国主库目录无法读取，请检查安装文件。",
			Checked: false,
		}
	}
	if !check {
		return koreanStatus{
			Status:  "current",
			Message: "当前目录已就绪，图片将按需读取。",
			Checked: false,
		}
	}
	if _, err := library.fetchRange(ctx, pack, 0, 1); err != nil {
		return koreanStatus{
			Status:  "failed",
			Message: "暂时无法核对韩国主库。请检查网络后重试，不会下载完整资源包。",
			Checked: false,
		}
	}
	return koreanStatus{
		Status:  "current",
		Message: "韩国主库原文件与当前目录一致。",
		Checked: true,
	}
}

func (library *koreanLibrary) image(ctx context.Context, packID string, offset int64, size int) ([]byte, string, error) {
	pack, err := library.load(packID)
	if err != nil {
		return nil, "", err
	}
	if _, ok := pack.spans[koreanSpan{offset: offset, size: size}]; !ok {
		return nil, "", notFound("图片不在内置索引中")
	}

	cachePath := filepath.Join(library.cacheRoot, "korean",
		cacheName(pack.identity, strconv.FormatInt(offset, 10), strconv.Itoa(size))+koreanImageCacheName)
	if cached, ok := readCache(cachePath, koreanImageLimit); ok {
		contentType := imageType(cached)
		if contentType != "" {
			_ = os.Chtimes(cachePath, time.Now(), time.Now())
			return cached, contentType, nil
		}
	}

	select {
	case library.downloads <- struct{}{}:
		defer func() { <-library.downloads }()
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}

	// A concurrent request may have populated the cache while this request waited.
	if cached, ok := readCache(cachePath, koreanImageLimit); ok {
		contentType := imageType(cached)
		if contentType != "" {
			return cached, contentType, nil
		}
	}

	encoded, err := library.fetchRange(ctx, pack, offset, size)
	if err != nil {
		var requestError *url.Error
		if errors.As(err, &requestError) {
			err = requestError.Err
		}
		logError("韩国主库样图读取失败", packID, err)
		return nil, "", upstreamFailure("韩国主库暂时无法读取，请稍后重试")
	}
	data, err := decodeKoreanImage(encoded)
	if err != nil {
		return nil, "", upstreamFailure("韩国主库返回的图片无法解析")
	}
	contentType := imageType(data)
	if contentType == "" {
		return nil, "", upstreamFailure("韩国主库返回的图片格式无效")
	}
	if err := writeCache(cachePath, data); err == nil {
		pruneCache(filepath.Dir(cachePath), koreanImageCacheName, koreanCacheBudget)
	}
	return data, contentType, nil
}

func (library *koreanLibrary) load(packID string) (*koreanPack, error) {
	filename, sourcePath, ok := koreanPackInfo(packID)
	if !ok {
		return nil, badRequest("未知画师图包")
	}
	library.mu.Lock()
	defer library.mu.Unlock()
	if pack := library.packs[packID]; pack != nil {
		return pack, nil
	}

	indexPath, err := secureWebPath(library.webRoot, "/"+filename)
	if err != nil {
		return nil, unavailable("韩国主库索引缺失或不可读")
	}
	info, err := os.Stat(indexPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() > koreanIndexLimit {
		return nil, unavailable("韩国主库索引缺失或过大")
	}
	file, err := os.Open(indexPath)
	if err != nil {
		return nil, unavailable("韩国主库索引不可读")
	}
	data, err := readLimited(file, koreanIndexLimit)
	file.Close()
	if err != nil {
		return nil, unavailable("韩国主库索引无法读取")
	}
	pack, err := parseKoreanPack(packID, filename, sourcePath, data)
	if err != nil {
		logError("韩国主库索引无效", packID, err)
		return nil, unavailable("韩国主库索引格式无效")
	}
	library.packs[packID] = pack
	return pack, nil
}

func koreanPackInfo(packID string) (filename, sourcePath string, ok bool) {
	var original string
	switch packID {
	case "curated":
		filename, original = "korean-index.json", "NAID5-33000-55000-Curated"
	case "33000":
		filename, original = "korean-33000-index.json", "NAID5F-33000-Q"
	case "55000":
		filename, original = "korean-55000-index.json", "NAID5F-55000-Q"
	default:
		return "", "", false
	}
	return filename, "/NAIA/NAID5_artist_thumbnail/" + original, true
}

func parseKoreanPack(packID, filename, sourcePath string, data []byte) (*koreanPack, error) {
	var document koreanIndexDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	if document.Format != "nai-pocket-korean-index" || document.Version != 1 {
		return nil, errors.New("unsupported index format")
	}
	source := document.Source
	expectedMain := koreanSourceRoot + "main" + sourcePath
	expectedRelease := koreanSourceRoot + koreanRelease + sourcePath
	if (source.URL != expectedMain && source.URL != expectedRelease) ||
		source.Bytes <= 0 || !koreanETagPattern.MatchString(source.ETag) {
		return nil, errors.New("invalid source identity")
	}
	if source.ID != "" && source.ID != packID {
		return nil, errors.New("index source id does not match pack")
	}
	if len(document.Artists) == 0 || len(document.Artists) > 60000 {
		return nil, errors.New("invalid artist count")
	}

	spans := make(map[koreanSpan]struct{})
	offsetSizes := make(map[int64]int)
	entries := 0
	for _, rawArtist := range document.Artists {
		var artist []json.RawMessage
		if err := json.Unmarshal(rawArtist, &artist); err != nil || len(artist) < 2 {
			return nil, errors.New("invalid artist entry")
		}
		var name string
		if err := json.Unmarshal(artist[0], &name); err != nil ||
			name == "" || utf8.RuneCountInString(name) > 400 {
			return nil, errors.New("invalid artist name")
		}
		var photos []json.RawMessage
		if err := json.Unmarshal(artist[1], &photos); err != nil ||
			len(photos) == 0 || len(photos) > 50 {
			return nil, errors.New("invalid preview count")
		}
		for _, rawPhoto := range photos {
			var photo []int64
			if err := json.Unmarshal(rawPhoto, &photo); err != nil || len(photo) != 2 {
				return nil, errors.New("invalid image span")
			}
			offset, sizeValue := photo[0], photo[1]
			if sizeValue <= 0 || sizeValue > koreanImageLimit {
				return nil, errors.New("invalid image size")
			}
			size := int(sizeValue)
			if !validKoreanSpan(offset, size, source.Bytes) {
				return nil, errors.New("invalid image span")
			}
			span := koreanSpan{offset: offset, size: size}
			if previousSize, duplicate := offsetSizes[offset]; duplicate {
				if previousSize != size {
					return nil, errors.New("conflicting image span")
				}
				continue
			}
			offsetSizes[offset] = size
			spans[span] = struct{}{}
			entries++
			if entries > 120000 {
				return nil, errors.New("too many image spans")
			}
		}
	}
	if entries == 0 {
		return nil, errors.New("empty image index")
	}
	return &koreanPack{
		id:        packID,
		filename:  filename,
		sourceURL: source.URL,
		bytes:     source.Bytes,
		etag:      source.ETag,
		identity:  source.URL + "/" + source.ETag + "/" + strconv.FormatInt(source.Bytes, 10),
		json:      data,
		spans:     spans,
	}, nil
}

func validKoreanSpan(offset int64, size int, total int64) bool {
	return offset > 0 && size > 0 && int64(size) <= koreanImageLimit &&
		total >= int64(size) && offset <= total-int64(size)
}

func (library *koreanLibrary) fetchRange(ctx context.Context, pack *koreanPack, offset int64, size int) ([]byte, error) {
	// An index status check reads the first byte, while preview spans always start after it.
	if !(offset == 0 && size == 1 && pack.bytes > 0) && !validKoreanSpan(offset, size, pack.bytes) {
		return nil, errors.New("invalid requested range")
	}
	current, err := url.Parse(pack.sourceURL)
	if err != nil {
		return nil, err
	}
	last := offset + int64(size) - 1

	for redirects := 0; redirects <= 4; redirects++ {
		if !allowedKoreanURL(current) {
			return nil, errors.New("unexpected source host")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, current.String(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, last))
		request.Header.Set("If-Range", pack.etag)
		request.Header.Set("Accept-Encoding", "identity")
		request.Header.Set("User-Agent", "NAI-Pocket-Library-Desktop/"+appVersion)

		response, err := library.client.Do(request)
		if err != nil {
			return nil, err
		}
		if response.StatusCode >= 300 && response.StatusCode <= 399 {
			linkedSize := strings.TrimSpace(response.Header.Get("X-Linked-Size"))
			location := response.Header.Get("Location")
			response.Body.Close()
			if linkedSize != "" && linkedSize != strconv.FormatInt(pack.bytes, 10) {
				return nil, errors.New("source size changed")
			}
			if redirects == 4 {
				return nil, errors.New("too many redirects")
			}
			next, err := safeRedirectTarget(current, location)
			if err != nil {
				return nil, err
			}
			current = next
			continue
		}

		if response.StatusCode == http.StatusPreconditionFailed ||
			response.StatusCode == http.StatusRequestedRangeNotSatisfiable {
			response.Body.Close()
			return nil, errors.New("source changed")
		}
		// A server that ignores Range would send the whole artist file here.
		if response.StatusCode != http.StatusPartialContent {
			response.Body.Close()
			return nil, errors.New("source did not return a partial response")
		}
		etag := strings.TrimSpace(response.Header.Get("ETag"))
		if etag == "" {
			response.Body.Close()
			return nil, errors.New("source has no fingerprint")
		}
		if etag != pack.etag {
			response.Body.Close()
			return nil, errors.New("source fingerprint changed")
		}
		contentEncoding := strings.TrimSpace(response.Header.Get("Content-Encoding"))
		if contentEncoding != "" && !strings.EqualFold(contentEncoding, "identity") {
			response.Body.Close()
			return nil, errors.New("unexpected content encoding")
		}
		match := koreanRangePattern.FindStringSubmatch(strings.TrimSpace(response.Header.Get("Content-Range")))
		if len(match) != 4 {
			response.Body.Close()
			return nil, errors.New("invalid content range")
		}
		first, firstErr := strconv.ParseInt(match[1], 10, 64)
		end, endErr := strconv.ParseInt(match[2], 10, 64)
		total, totalErr := strconv.ParseInt(match[3], 10, 64)
		if firstErr != nil || endErr != nil || totalErr != nil ||
			first != offset || end != last || total != pack.bytes {
			response.Body.Close()
			return nil, errors.New("unexpected content range")
		}
		if response.ContentLength >= 0 && response.ContentLength != int64(size) {
			response.Body.Close()
			return nil, errors.New("unexpected content length")
		}
		data, readErr := readLimited(response.Body, int64(size))
		response.Body.Close()
		if readErr != nil || len(data) != size {
			return nil, errors.New("incomplete partial response")
		}
		return data, nil
	}
	return nil, errors.New("too many redirects")
}

func allowedKoreanURL(target *url.URL) bool {
	if target == nil || target.Scheme != "https" || target.User != nil ||
		target.Fragment != "" || target.RawFragment != "" ||
		!validHeaderCacheValue(target.Host, 512) {
		return false
	}
	if target.Port() != "" && target.Port() != "443" {
		return false
	}
	return target.Hostname() == "huggingface.co" || target.Hostname() == "us.aws.cdn.hf.co"
}

func decodeKoreanImage(encoded []byte) ([]byte, error) {
	if len(encoded) == 0 || len(encoded) > koreanImageLimit {
		return nil, errors.New("invalid image range")
	}
	var raw string
	if err := json.Unmarshal([]byte(`"`+string(encoded)+`"`), &raw); err != nil {
		return nil, err
	}
	if strings.HasPrefix(raw, "data:") {
		comma := strings.IndexByte(raw, ',')
		if comma < 0 || comma > 96 || !strings.HasSuffix(raw[:comma], ";base64") {
			return nil, errors.New("invalid data image")
		}
		raw = raw[comma+1:]
	}
	var compact strings.Builder
	compact.Grow(len(raw))
	for _, character := range raw {
		switch character {
		case ' ', '\t', '\r', '\n':
			continue
		default:
			compact.WriteRune(character)
		}
	}
	base64Text := compact.String()
	image, err := base64.StdEncoding.DecodeString(base64Text)
	if err != nil {
		image, err = base64.RawStdEncoding.DecodeString(base64Text)
	}
	if err != nil || len(image) == 0 || len(image) > koreanImageLimit || imageType(image) == "" {
		return nil, errors.New("invalid preview image")
	}
	return image, nil
}

func logError(message, subject string, err error) {
	log.Printf("%s (%s): %v", message, subject, err)
}
