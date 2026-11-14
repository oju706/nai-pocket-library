package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	danbooruPostsEndpoint        = "https://danbooru.donmai.us/posts.json"
	danbooruAutocompleteEndpoint = "https://danbooru.donmai.us/autocomplete.json"
	danbooruImageRoute           = "/tag-gallery-image/"
	danbooruPageSize             = 24
	danbooruMaxPage              = 1000
	danbooruMaxQueryRunes        = 512
	danbooruMaxQueryTerms        = 64
	danbooruMaxTagRunes          = 200
	danbooruMaxPostTags          = 500
	danbooruMaxSuggestQuery      = 100
	danbooruMaxJSONBytes         = 2 << 20
	danbooruMaxThumbnailBytes    = 1 << 20
	danbooruMaxPreviewBytes      = 8 << 20
	danbooruMaxImageURLBytes     = 2048
	danbooruMaxImageTokens       = 4096
	danbooruTokenLifetime        = 30 * time.Minute
)

var (
	danbooruHTTPClient = &http.Client{
		Transport: &http.Transport{
			Proxy:                 desktopUpstreamProxy,
			DialContext:           (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          8,
			MaxIdleConnsPerHost:   4,
			MaxConnsPerHost:       6,
			IdleConnTimeout:       60 * time.Second,
			TLSHandshakeTimeout:   8 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
			ExpectContinueTimeout: time.Second,
			DisableCompression:    true,
			TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		},
		Timeout: 20 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	danbooruAPIRequests   = make(chan struct{}, 4)
	danbooruImageRequests = make(chan struct{}, 3)
)

type danbooruGallery struct {
	tokenMu  sync.Mutex
	tokens   map[string]*danbooruImageSource
	sequence uint64
}

type danbooruImageSource struct {
	url     *url.URL
	limit   int64
	expires time.Time
	created uint64
}

type danbooruFailure struct {
	status  int
	code    string
	message string
}

func (failure *danbooruFailure) Error() string {
	return failure.message
}

type danbooruPostView struct {
	ID        int64             `json:"id"`
	Thumbnail string            `json:"thumbnail"`
	Preview   string            `json:"preview"`
	PostURL   string            `json:"postUrl"`
	Rating    string            `json:"rating"`
	Score     int               `json:"score"`
	Width     int               `json:"width"`
	Height    int               `json:"height"`
	Title     string            `json:"title"`
	Tags      []danbooruTagView `json:"tags"`
}

type danbooruTagView struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type danbooruSuggestionView struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Count *int   `json:"count,omitempty"`
}

type danbooruPostsResponse struct {
	Items   []danbooruPostView `json:"items"`
	HasNext bool               `json:"hasNext"`
	Page    int                `json:"page"`
}

type danbooruTagsResponse struct {
	Tags []danbooruSuggestionView `json:"tags"`
}

type danbooruErrorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type danbooruPostWire struct {
	ID               int64  `json:"id"`
	Rating           string `json:"rating"`
	Score            int    `json:"score"`
	ImageWidth       int    `json:"image_width"`
	ImageHeight      int    `json:"image_height"`
	PreviewFileURL   string `json:"preview_file_url"`
	LargeFileURL     string `json:"large_file_url"`
	FileURL          string `json:"file_url"`
	FileExt          string `json:"file_ext"`
	IsDeleted        bool   `json:"is_deleted"`
	IsBanned         bool   `json:"is_banned"`
	IsVideo          bool   `json:"is_video"`
	Title            string `json:"title"`
	TagStringArtist  string `json:"tag_string_artist"`
	TagStringCopy    string `json:"tag_string_copyright"`
	TagStringChar    string `json:"tag_string_character"`
	TagStringGeneral string `json:"tag_string_general"`
	TagStringMeta    string `json:"tag_string_meta"`
	TagString        string `json:"tag_string"`
	MediaAsset       struct {
		FileExt  string `json:"file_ext"`
		IsVideo  bool   `json:"is_video"`
		Variants []struct {
			Type string `json:"type"`
			URL  string `json:"url"`
		} `json:"variants"`
	} `json:"media_asset"`
}

type danbooruAutocompleteWire struct {
	Name      string          `json:"name"`
	Value     string          `json:"value"`
	Label     string          `json:"label"`
	Category  json.RawMessage `json:"category"`
	PostCount *int            `json:"post_count"`
}

type danbooruImageCandidate struct {
	url   *url.URL
	limit int64
}

func registerDanbooru(mux *http.ServeMux) {
	if mux == nil {
		return
	}
	gallery := &danbooruGallery{tokens: make(map[string]*danbooruImageSource)}
	mux.HandleFunc("/api/tag-gallery/posts", gallery.handlePosts)
	mux.HandleFunc("/api/tag-gallery/tags", gallery.handleTags)
	mux.HandleFunc(danbooruImageRoute, gallery.handleImage)
}

func (gallery *danbooruGallery) handlePosts(writer http.ResponseWriter, request *http.Request) {
	if !danbooruRequireGET(writer, request) || !danbooruRequireSite(writer, request) {
		return
	}
	page, failure := danbooruParsePage(request.URL.Query().Get("page"))
	if failure != nil {
		danbooruWriteFailure(writer, failure)
		return
	}
	rating := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("rating")))
	if rating == "" {
		rating = "general"
	}
	if !danbooruValidRating(rating) {
		danbooruWriteFailure(writer, danbooruNewFailure(http.StatusBadRequest, "rating", "分级选项无效。"))
		return
	}
	sortMode := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("sort")))
	if sortMode == "" {
		sortMode = "newest"
	}
	if sortMode != "newest" && sortMode != "popular" {
		danbooruWriteFailure(writer, danbooruNewFailure(http.StatusBadRequest, "sort", "排序选项无效。"))
		return
	}
	tags, failure := danbooruCleanQuery(request.URL.Query().Get("query"))
	if failure != nil {
		danbooruWriteFailure(writer, failure)
		return
	}
	if rating != "all" {
		tags = strings.TrimSpace(tags + " rating:" + rating)
	}
	if sortMode == "popular" {
		tags = strings.TrimSpace(tags + " order:score")
	}

	values := make(url.Values)
	values.Set("limit", strconv.Itoa(danbooruPageSize))
	values.Set("page", strconv.Itoa(page))
	values.Set("tags", tags)
	body, failure := danbooruFetchJSON(request.Context(), danbooruPostsEndpoint, values)
	if failure != nil {
		danbooruWriteFailure(writer, failure)
		return
	}
	rows, failure := danbooruDecodeRows(body, "posts")
	if failure != nil {
		danbooruWriteFailure(writer, failure)
		return
	}
	items := make([]danbooruPostView, 0, danbooruMinInt(len(rows), danbooruPageSize))
	for index, raw := range rows {
		if index >= danbooruPageSize {
			break
		}
		view, ok := gallery.toPost(raw, rating)
		if ok {
			items = append(items, view)
		}
	}
	danbooruWriteJSON(writer, http.StatusOK, danbooruPostsResponse{
		Items:   items,
		HasNext: page < danbooruMaxPage && len(rows) >= danbooruPageSize,
		Page:    page,
	})
}

func (gallery *danbooruGallery) handleTags(writer http.ResponseWriter, request *http.Request) {
	if !danbooruRequireGET(writer, request) || !danbooruRequireSite(writer, request) {
		return
	}
	query := strings.TrimSpace(request.URL.Query().Get("query"))
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) > danbooruMaxQueryRunes ||
		strings.IndexFunc(query, unicode.IsControl) >= 0 {
		danbooruWriteFailure(writer, danbooruNewFailure(http.StatusBadRequest, "query", "标签过长或包含无效字符。"))
		return
	}
	query = strings.TrimLeft(query, "-~")
	if utf8.RuneCountInString(query) < 2 || utf8.RuneCountInString(query) > danbooruMaxSuggestQuery ||
		strings.ContainsAny(query, " \t\r\n:") {
		danbooruWriteJSON(writer, http.StatusOK, danbooruTagsResponse{Tags: make([]danbooruSuggestionView, 0)})
		return
	}

	values := make(url.Values)
	values.Set("search[query]", query)
	values.Set("search[type]", "tag_query")
	values.Set("limit", "10")
	body, failure := danbooruFetchJSON(request.Context(), danbooruAutocompleteEndpoint, values)
	if failure != nil {
		danbooruWriteFailure(writer, failure)
		return
	}
	var rows []danbooruAutocompleteWire
	if err := json.Unmarshal(body, &rows); err != nil {
		danbooruWriteFailure(writer, danbooruNewFailure(http.StatusBadGateway, "upstream", "图库返回了无效的标签数据。"))
		return
	}
	tags := make([]danbooruSuggestionView, 0, danbooruMinInt(len(rows), 10))
	seen := make(map[string]struct{}, danbooruMinInt(len(rows), 10))
	for index, row := range rows {
		if index >= 10 {
			break
		}
		name := row.Name
		if name == "" {
			name = row.Value
		}
		if name == "" {
			name = row.Label
		}
		if !danbooruValidTag(name) {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		count := row.PostCount
		if count != nil && *count < 0 {
			count = nil
		}
		tags = append(tags, danbooruSuggestionView{
			Name:  name,
			Kind:  danbooruTagKind(row.Category),
			Count: count,
		})
	}
	danbooruWriteJSON(writer, http.StatusOK, danbooruTagsResponse{Tags: tags})
}

func (gallery *danbooruGallery) handleImage(writer http.ResponseWriter, request *http.Request) {
	if !danbooruRequireGET(writer, request) {
		return
	}
	token := strings.TrimPrefix(request.URL.Path, danbooruImageRoute)
	if !danbooruValidUUID(token) {
		danbooruWriteImageFailure(writer, http.StatusNotFound)
		return
	}
	source, ok := gallery.lookupImage(token)
	if !ok {
		danbooruWriteImageFailure(writer, http.StatusNotFound)
		return
	}
	select {
	case danbooruImageRequests <- struct{}{}:
		defer func() { <-danbooruImageRequests }()
	case <-request.Context().Done():
		danbooruWriteImageFailure(writer, http.StatusGatewayTimeout)
		return
	case <-time.After(5 * time.Second):
		danbooruWriteImageFailure(writer, http.StatusServiceUnavailable)
		return
	}
	if !danbooruSafeImageURL(source.url) {
		danbooruWriteImageFailure(writer, http.StatusBadGateway)
		return
	}
	upstreamRequest, err := http.NewRequestWithContext(request.Context(), http.MethodGet, source.url.String(), nil)
	if err != nil {
		danbooruWriteImageFailure(writer, http.StatusBadGateway)
		return
	}
	upstreamRequest.Header.Set("Accept", "image/webp,image/png,image/jpeg,image/gif")
	upstreamRequest.Header.Set("Accept-Encoding", "identity")
	upstreamRequest.Header.Set("User-Agent", "NAIPocketLibrary-Windows/1.3")
	response, err := danbooruHTTPClient.Do(upstreamRequest)
	if err != nil {
		danbooruWriteImageFailure(writer, danbooruImageTransportStatus(request.Context(), err))
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > source.limit {
		danbooruWriteImageFailure(writer, http.StatusBadGateway)
		return
	}
	image, failure := danbooruReadLimited(response.Body, source.limit)
	if failure != nil {
		danbooruWriteImageFailure(writer, http.StatusBadGateway)
		return
	}
	contentType := danbooruImageContentType(image)
	if contentType == "" {
		danbooruWriteImageFailure(writer, http.StatusBadGateway)
		return
	}
	writer.Header().Set("Cache-Control", "private, max-age=3600")
	writer.Header().Set("Content-Length", strconv.Itoa(len(image)))
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(image)
}

func (gallery *danbooruGallery) toPost(raw json.RawMessage, requestedRating string) (danbooruPostView, bool) {
	var row danbooruPostWire
	if err := json.Unmarshal(raw, &row); err != nil || row.ID <= 0 {
		return danbooruPostView{}, false
	}
	rating := danbooruNormalizeRating(row.Rating)
	if rating == "" || (requestedRating != "all" && requestedRating != rating) {
		return danbooruPostView{}, false
	}
	if row.IsDeleted || row.IsBanned || row.IsVideo || row.MediaAsset.IsVideo ||
		danbooruUnsupportedExtension(row.FileExt) || danbooruUnsupportedExtension(row.MediaAsset.FileExt) {
		return danbooruPostView{}, false
	}

	thumbnail := danbooruImageCandidate{
		url:   danbooruFirstSafeImage(danbooruMediaVariant(row, "360x360"), row.PreviewFileURL),
		limit: danbooruMaxThumbnailBytes,
	}
	preview := danbooruImageCandidate{
		url:   danbooruFirstSafeImage(danbooruMediaVariant(row, "720x720"), row.LargeFileURL, row.FileURL),
		limit: danbooruMaxPreviewBytes,
	}
	if preview.url == nil {
		preview = thumbnail
	}
	if thumbnail.url == nil {
		thumbnail = preview
	}
	if thumbnail.url == nil {
		return danbooruPostView{}, false
	}
	thumbnailPath, ok := gallery.registerImage(thumbnail)
	if !ok {
		thumbnail = preview
		thumbnailPath, ok = gallery.registerImage(thumbnail)
	}
	if !ok {
		return danbooruPostView{}, false
	}
	previewPath, ok := gallery.registerImage(preview)
	if !ok || previewPath == "" {
		previewPath = thumbnailPath
	}

	tags := make([]danbooruTagView, 0, 24)
	seen := make(map[string]struct{}, 24)
	appendDanbooruTags(&tags, seen, row.TagStringArtist, "画师")
	appendDanbooruTags(&tags, seen, row.TagStringCopy, "作品")
	appendDanbooruTags(&tags, seen, row.TagStringChar, "角色")
	appendDanbooruTags(&tags, seen, row.TagStringGeneral, "通用")
	appendDanbooruTags(&tags, seen, row.TagStringMeta, "元数据")
	appendDanbooruTags(&tags, seen, row.TagString, "")

	return danbooruPostView{
		ID:        row.ID,
		Thumbnail: thumbnailPath,
		Preview:   previewPath,
		PostURL:   "https://danbooru.donmai.us/posts/" + strconv.FormatInt(row.ID, 10),
		Rating:    rating,
		Score:     row.Score,
		Width:     row.ImageWidth,
		Height:    row.ImageHeight,
		Title:     danbooruTruncate(row.Title, danbooruMaxTagRunes),
		Tags:      tags,
	}, true
}

func (gallery *danbooruGallery) registerImage(candidate danbooruImageCandidate) (string, bool) {
	if candidate.url == nil || candidate.limit <= 0 || !danbooruSafeImageURL(candidate.url) {
		return "", false
	}
	now := time.Now()
	gallery.tokenMu.Lock()
	defer gallery.tokenMu.Unlock()
	gallery.purgeExpiredTokensLocked(now)
	if len(gallery.tokens) >= danbooruMaxImageTokens {
		var oldestToken string
		var oldestSequence uint64
		for token, source := range gallery.tokens {
			if oldestToken == "" || source.created < oldestSequence {
				oldestToken = token
				oldestSequence = source.created
			}
		}
		delete(gallery.tokens, oldestToken)
	}
	for attempt := 0; attempt < 4; attempt++ {
		token, ok := danbooruUUID()
		if !ok {
			return "", false
		}
		if _, exists := gallery.tokens[token]; exists {
			continue
		}
		gallery.sequence++
		imageURL := *candidate.url
		gallery.tokens[token] = &danbooruImageSource{
			url:     &imageURL,
			limit:   candidate.limit,
			expires: now.Add(danbooruTokenLifetime),
			created: gallery.sequence,
		}
		return danbooruImageRoute + token, true
	}
	return "", false
}

func (gallery *danbooruGallery) lookupImage(token string) (*danbooruImageSource, bool) {
	now := time.Now()
	gallery.tokenMu.Lock()
	defer gallery.tokenMu.Unlock()
	source, ok := gallery.tokens[token]
	if !ok {
		return nil, false
	}
	if !source.expires.After(now) {
		delete(gallery.tokens, token)
		return nil, false
	}
	source.expires = now.Add(danbooruTokenLifetime)
	return source, true
}

func (gallery *danbooruGallery) purgeExpiredTokensLocked(now time.Time) {
	for token, source := range gallery.tokens {
		if !source.expires.After(now) {
			delete(gallery.tokens, token)
		}
	}
}

func danbooruFetchJSON(ctx context.Context, endpoint string, values url.Values) ([]byte, *danbooruFailure) {
	base, err := url.Parse(endpoint)
	if err != nil || !danbooruAllowedAPIEndpoint(base) {
		return nil, danbooruNewFailure(http.StatusBadGateway, "upstream", "图库地址配置无效。")
	}
	base.RawQuery = values.Encode()
	select {
	case danbooruAPIRequests <- struct{}{}:
		defer func() { <-danbooruAPIRequests }()
	case <-ctx.Done():
		return nil, danbooruNewFailure(http.StatusGatewayTimeout, "timeout", "图库请求已超时。")
	case <-time.After(3 * time.Second):
		return nil, danbooruNewFailure(http.StatusServiceUnavailable, "busy", "图库请求正忙，请稍后重试。")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return nil, danbooruNewFailure(http.StatusBadGateway, "upstream", "无法构造图库请求。")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "NAIPocketLibrary-Windows/1.3")
	response, err := danbooruHTTPClient.Do(request)
	if err != nil {
		return nil, danbooruTransportFailure(ctx)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, danbooruUpstreamFailure(response.StatusCode)
	}
	body, failure := danbooruReadLimited(response.Body, danbooruMaxJSONBytes)
	if failure != nil || response.ContentLength > danbooruMaxJSONBytes {
		return nil, danbooruNewFailure(http.StatusBadGateway, "upstream", "图库响应过大或不完整。")
	}
	return body, nil
}

func danbooruDecodeRows(body []byte, wrapperKey string) ([]json.RawMessage, *danbooruFailure) {
	var rows []json.RawMessage
	if err := json.Unmarshal(body, &rows); err == nil {
		return rows, nil
	}
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal(body, &wrapper); err != nil {
		return nil, danbooruNewFailure(http.StatusBadGateway, "upstream", "图库返回了无效的数据。")
	}
	raw, exists := wrapper[wrapperKey]
	if !exists || json.Unmarshal(raw, &rows) != nil {
		return nil, danbooruNewFailure(http.StatusBadGateway, "upstream", "图库返回了无效的数据。")
	}
	return rows, nil
}

func danbooruCleanQuery(raw string) (string, *danbooruFailure) {
	if !utf8.ValidString(raw) || utf8.RuneCountInString(strings.TrimSpace(raw)) > danbooruMaxQueryRunes ||
		strings.IndexFunc(raw, unicode.IsControl) >= 0 {
		return "", danbooruNewFailure(http.StatusBadRequest, "query", "标签过长或包含无效字符。")
	}
	fields := strings.Fields(raw)
	if len(fields) > danbooruMaxQueryTerms {
		return "", danbooruNewFailure(http.StatusBadRequest, "query", "标签数量过多。")
	}
	cleaned := make([]string, 0, len(fields))
	for _, term := range fields {
		if utf8.RuneCountInString(term) > danbooruMaxTagRunes {
			return "", danbooruNewFailure(http.StatusBadRequest, "query", "单个标签过长。")
		}
		if danbooruConflictingMetaTag(term) {
			continue
		}
		cleaned = append(cleaned, term)
	}
	return strings.Join(cleaned, " "), nil
}

func danbooruConflictingMetaTag(term string) bool {
	value := strings.ToLower(strings.TrimLeft(term, "-~"))
	return strings.HasPrefix(value, "rating:") ||
		strings.HasPrefix(value, "order:") ||
		strings.HasPrefix(value, "sort:")
}

func danbooruParsePage(raw string) (int, *danbooruFailure) {
	if raw == "" {
		return 1, nil
	}
	if len(raw) == 0 || len(raw) > 4 || raw[0] < '1' || raw[0] > '9' {
		return 0, danbooruNewFailure(http.StatusBadRequest, "page", "页码超出范围。")
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, danbooruNewFailure(http.StatusBadRequest, "page", "页码超出范围。")
		}
	}
	page, err := strconv.Atoi(raw)
	if err != nil || page < 1 || page > danbooruMaxPage {
		return 0, danbooruNewFailure(http.StatusBadRequest, "page", "页码超出范围。")
	}
	return page, nil
}

func danbooruValidRating(value string) bool {
	switch value {
	case "all", "general", "sensitive", "questionable", "explicit":
		return true
	default:
		return false
	}
}

func danbooruNormalizeRating(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "g", "safe", "general":
		return "general"
	case "s", "sensitive":
		return "sensitive"
	case "q", "questionable":
		return "questionable"
	case "e", "explicit":
		return "explicit"
	default:
		return ""
	}
}

func danbooruMediaVariant(row danbooruPostWire, kind string) string {
	for _, variant := range row.MediaAsset.Variants {
		if variant.Type == kind {
			return variant.URL
		}
	}
	return ""
}

func danbooruFirstSafeImage(values ...string) *url.URL {
	for _, value := range values {
		parsed, err := url.Parse(strings.TrimSpace(value))
		if err == nil && danbooruSafeImageURL(parsed) {
			return parsed
		}
	}
	return nil
}

func danbooruSafeImageURL(parsed *url.URL) bool {
	if parsed == nil || len(parsed.String()) > danbooruMaxImageURLBytes ||
		!strings.EqualFold(parsed.Scheme, "https") ||
		!strings.EqualFold(parsed.Hostname(), "cdn.donmai.us") ||
		parsed.Port() != "" || parsed.User != nil || parsed.Opaque != "" ||
		parsed.Fragment != "" || parsed.RawFragment != "" ||
		parsed.RawQuery != "" || parsed.ForceQuery ||
		!strings.HasPrefix(parsed.Path, "/") || strings.Contains(parsed.Path, "\\") {
		return false
	}
	lowerPath := strings.ToLower(parsed.Path)
	if strings.Contains(lowerPath, "%2e") || strings.Contains(lowerPath, "%2f") ||
		strings.Contains(lowerPath, "%5c") || path.Clean(parsed.Path) != parsed.Path {
		return false
	}
	switch path.Ext(lowerPath) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif":
		return true
	default:
		return false
	}
}

func danbooruAllowedAPIEndpoint(parsed *url.URL) bool {
	if parsed == nil || !strings.EqualFold(parsed.Scheme, "https") ||
		!strings.EqualFold(parsed.Hostname(), "danbooru.donmai.us") ||
		parsed.Port() != "" || parsed.User != nil || parsed.Opaque != "" ||
		parsed.Fragment != "" || parsed.RawFragment != "" {
		return false
	}
	return parsed.Path == "/posts.json" || parsed.Path == "/autocomplete.json"
}

func danbooruUnsupportedExtension(extension string) bool {
	switch strings.ToLower(strings.TrimSpace(extension)) {
	case "mp4", "webm", "zip", "swf", "avi", "mkv", "mov", "m4v", "mpeg", "mpg":
		return true
	default:
		return false
	}
}

func appendDanbooruTags(tags *[]danbooruTagView, seen map[string]struct{}, value string, kind string) {
	for _, name := range strings.Fields(value) {
		if len(*tags) >= danbooruMaxPostTags || !danbooruValidTag(name) {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		*tags = append(*tags, danbooruTagView{Name: name, Kind: kind})
	}
}

func danbooruValidTag(value string) bool {
	return value != "" && utf8.ValidString(value) &&
		utf8.RuneCountInString(value) <= danbooruMaxTagRunes &&
		strings.IndexFunc(value, func(char rune) bool {
			return unicode.IsSpace(char) || unicode.IsControl(char)
		}) < 0
}

func danbooruTagKind(raw json.RawMessage) string {
	var category int
	if len(raw) > 0 && json.Unmarshal(raw, &category) == nil {
		switch category {
		case 1:
			return "画师"
		case 3:
			return "作品"
		case 4:
			return "角色"
		case 5:
			return "元数据"
		case 0:
			return "通用"
		default:
			return ""
		}
	}
	var name string
	if len(raw) > 0 && json.Unmarshal(raw, &name) == nil {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "artist":
			return "画师"
		case "copyright":
			return "作品"
		case "character":
			return "角色"
		case "meta", "metadata":
			return "元数据"
		case "general":
			return "通用"
		}
	}
	return ""
}

func danbooruTruncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func danbooruUUID() (string, bool) {
	var value [16]byte
	if _, err := io.ReadFull(rand.Reader, value[:]); err != nil {
		return "", false
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" +
		encoded[16:20] + "-" + encoded[20:], true
}

func danbooruValidUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

func danbooruReadLimited(reader io.Reader, limit int64) ([]byte, *danbooruFailure) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, danbooruNewFailure(http.StatusBadGateway, "upstream", "图库响应过大或不完整。")
	}
	return body, nil
}

func danbooruImageContentType(body []byte) string {
	switch {
	case len(body) >= 8 && string(body[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(body) >= 3 && body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff:
		return "image/jpeg"
	case len(body) >= 6 && (string(body[:6]) == "GIF87a" || string(body[:6]) == "GIF89a"):
		return "image/gif"
	case len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP":
		return "image/webp"
	default:
		return ""
	}
}

func danbooruRequireGET(writer http.ResponseWriter, request *http.Request) bool {
	if request.Method == http.MethodGet {
		return true
	}
	writer.Header().Set("Allow", http.MethodGet)
	danbooruWriteFailure(writer, danbooruNewFailure(http.StatusMethodNotAllowed, "method", "仅支持 GET 请求。"))
	return false
}

func danbooruRequireSite(writer http.ResponseWriter, request *http.Request) bool {
	site := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("site")))
	if site == "" || site == "danbooru" {
		return true
	}
	if site == "gelbooru" {
		danbooruWriteFailure(writer, danbooruNewFailure(http.StatusNotImplemented, "external-site", "Windows 版仅接入 Danbooru；Gelbooru 请在官网打开。"))
		return false
	}
	danbooruWriteFailure(writer, danbooruNewFailure(http.StatusBadRequest, "site", "图库来源无效。"))
	return false
}

func danbooruNewFailure(status int, code string, message string) *danbooruFailure {
	return &danbooruFailure{status: status, code: code, message: message}
}

func danbooruUpstreamFailure(status int) *danbooruFailure {
	switch status {
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return danbooruNewFailure(http.StatusBadRequest, "query", "站点无法执行此查询，请尝试减少标签。")
	case http.StatusUnauthorized, http.StatusForbidden:
		return danbooruNewFailure(http.StatusForbidden, "forbidden", "站点拒绝了公开图库请求。")
	case http.StatusTooManyRequests:
		return danbooruNewFailure(http.StatusTooManyRequests, "rate-limit", "图库请求过多，请稍后重试。")
	case http.StatusGatewayTimeout:
		return danbooruNewFailure(http.StatusGatewayTimeout, "timeout", "图库请求已超时。")
	default:
		return danbooruNewFailure(http.StatusBadGateway, "upstream", "图库暂时没有返回可用数据。")
	}
}

func danbooruTransportFailure(ctx context.Context) *danbooruFailure {
	if ctx.Err() != nil {
		return danbooruNewFailure(http.StatusGatewayTimeout, "timeout", "图库请求已超时。")
	}
	return danbooruNewFailure(http.StatusBadGateway, "upstream", "暂时无法连接图库。")
}

func danbooruImageTransportStatus(ctx context.Context, err error) int {
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

func danbooruWriteJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func danbooruWriteFailure(writer http.ResponseWriter, failure *danbooruFailure) {
	if failure == nil {
		failure = danbooruNewFailure(http.StatusInternalServerError, "internal", "图库请求失败。")
	}
	danbooruWriteJSON(writer, failure.status, danbooruErrorResponse{Error: failure.message, Code: failure.code})
}

func danbooruWriteImageFailure(writer http.ResponseWriter, status int) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_, _ = io.WriteString(writer, "gallery image unavailable\n")
}

func danbooruMinInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
