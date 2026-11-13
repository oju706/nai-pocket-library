package app.nai.pocketlibrary;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import android.util.LruCache;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

final class TagGallery {
    static final String IMAGE_ROUTE = "tag-gallery-image";
    private static final String USER_AGENT = "NAIPocketLibrary/1.3 (https://github.com/oju706/nai-pocket-library)";
    private static final int PAGE_SIZE = 24;
    private static final int MAX_PAGE = 1000;
    private static final int MAX_JSON = 2 * 1024 * 1024;
    private static final int MAX_THUMB = 1024 * 1024;
    private static final int MAX_PREVIEW = 8 * 1024 * 1024;

    private final TagGalleryCredentials credentials;
    private final RequestPace danbooruPace = new RequestPace();
    private final RequestPace gelbooruPace = new RequestPace();
    private final Semaphore imageRequests = new Semaphore(3, true);
    private final LruCache<String, ImageSource> imageSources = new LruCache<>(1024);
    private final LruCache<String, byte[]> imageCache = new LruCache<String, byte[]>(12 * 1024 * 1024) {
        @Override protected int sizeOf(String key, byte[] value) { return value.length; }
    };

    TagGallery(Context context) { credentials = new TagGalleryCredentials(context); }

    static final class Failure extends IOException {
        final int status;
        final String code;

        Failure(int status, String code, String message) {
            super(message);
            this.status = status;
            this.code = code;
        }
    }

    private enum Site {
        DANBOORU("https://danbooru.donmai.us"), GELBOORU("https://gelbooru.com");

        final String base;

        Site(String base) { this.base = base; }

        static Site from(String value) throws Failure {
            if ("danbooru".equals(value)) return DANBOORU;
            if ("gelbooru".equals(value)) return GELBOORU;
            throw new Failure(400, "site", "请选择 Danbooru 或 Gelbooru。");
        }

        Uri.Builder endpoint(String path) { return Uri.parse(base + path).buildUpon(); }

        String postUrl(long id) {
            return this == DANBOORU ? base + "/posts/" + id : base + "/index.php?page=post&s=view&id=" + id;
        }
    }

    private static final class RequestPace {
        private long nextStart;

        void awaitTurn() throws Failure {
            long wait;
            synchronized (this) {
                long now = android.os.SystemClock.elapsedRealtime();
                wait = Math.max(0, nextStart - now);
                if (wait > 2500) throw httpFailure(429);
                nextStart = now + wait + 1000;
            }
            try { Thread.sleep(wait); }
            catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new Failure(503, "interrupted", "请求已中断，请重试。");
            }
        }
    }

    private static final class ImageSource {
        final Site site;
        final URI uri;
        final int limit;

        ImageSource(Site site, URI uri, int limit) {
            this.site = site;
            this.uri = uri;
            this.limit = limit;
        }
    }

    JSONObject credentialStatus(String site) throws IOException, JSONException {
        Site.from(site);
        return new JSONObject().put("configured", credentials.load(site) != null);
    }

    void saveCredentials(String value) throws IOException, JSONException {
        JSONObject data = new JSONObject(value);
        credentials.save(data.getString("site"), data.optString("account", "").trim(), data.optString("key", "").trim());
    }

    JSONObject posts(Uri request) throws IOException, JSONException {
        String id = request.getQueryParameter("site");
        Site site = Site.from(id);
        String rating = request.getQueryParameter("rating");
        if (rating == null) rating = "general";
        if (!"all".equals(rating) && !rating.equals(normalizeRating(rating))) {
            throw new Failure(400, "rating", "分级选项无效。");
        }
        int page = parsePage(request.getQueryParameter("page"));
        String sort = request.getQueryParameter("sort");
        if (sort != null && !"newest".equals(sort) && !"popular".equals(sort)) {
            throw new Failure(400, "sort", "排序选项无效。");
        }
        TagGalleryCredentials.Account account = account(site, id);
        String query = checkedQuery(request.getQueryParameter("query"));
        String tags = postQuery(site, query, rating, "popular".equals(sort));
        Uri.Builder endpoint;
        if (site == Site.DANBOORU) {
            endpoint = site.endpoint("/posts.json").appendQueryParameter("limit", String.valueOf(PAGE_SIZE))
                    .appendQueryParameter("page", String.valueOf(page));
        } else {
            endpoint = gelbooruEndpoint("post", account, PAGE_SIZE)
                    .appendQueryParameter("pid", String.valueOf(page - 1));
        }
        if (!tags.isEmpty()) endpoint.appendQueryParameter("tags", tags);
        Object result = requestJson(site, endpoint, account);
        JSONArray rows = getRows(result, "post");
        int total = -1;
        if (result instanceof JSONObject) {
            JSONObject attributes = ((JSONObject) result).optJSONObject("@attributes");
            if (attributes != null) total = attributes.optInt("count", -1);
        }
        JSONArray posts = new JSONArray();
        for (int i = 0; i < Math.min(rows.length(), PAGE_SIZE); i++) {
            JSONObject row = rows.optJSONObject(i);
            JSONObject post = row == null ? null : toPost(site, row, rating);
            if (post != null) posts.put(post);
        }
        boolean next = page < MAX_PAGE && (total >= 0 ? (long) page * PAGE_SIZE < total : rows.length() >= PAGE_SIZE);
        JSONObject response = new JSONObject().put("items", posts).put("hasNext", next).put("page", page);
        if (total >= 0) response.put("total", total);
        return response;
    }

    JSONObject tags(Uri request) throws IOException, JSONException {
        String id = request.getQueryParameter("site");
        Site site = Site.from(id);
        String query = checkedQuery(request.getQueryParameter("query")).replaceFirst("^[-~]", "");
        JSONArray tags = new JSONArray();
        if (query.length() < 2 || query.length() > 100 || query.contains(" ") || query.contains(":")) {
            return new JSONObject().put("tags", tags);
        }
        TagGalleryCredentials.Account account = account(site, id);
        Uri.Builder endpoint = site == Site.DANBOORU
                ? site.endpoint("/autocomplete.json").appendQueryParameter("search[query]", query)
                        .appendQueryParameter("search[type]", "tag_query").appendQueryParameter("limit", "10")
                : gelbooruEndpoint("tag", account, 10).appendQueryParameter("name_pattern", gelbooruPattern(query))
                        .appendQueryParameter("orderby", "count").appendQueryParameter("order", "DESC");
        JSONArray rows = getRows(requestJson(site, endpoint, account), "tag");
        for (int i = 0; i < Math.min(10, rows.length()); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String name = row.optString(site == Site.DANBOORU ? "value" : "name", "");
            if (!validTag(name)) continue;
            JSONObject tag = new JSONObject().put("name", name)
                    .put("kind", tagKind(row.optString(site == Site.DANBOORU ? "category" : "type", "")));
            int count = row.optInt(site == Site.DANBOORU ? "post_count" : "count", -1);
            if (count >= 0) tag.put("count", count);
            tags.put(tag);
        }
        return new JSONObject().put("tags", tags);
    }

    private TagGalleryCredentials.Account account(Site site, String id) throws IOException {
        TagGalleryCredentials.Account account = credentials.load(id);
        if (site == Site.GELBOORU && account == null) throw httpFailure(401);
        return account;
    }

    private static Uri.Builder gelbooruEndpoint(String type, TagGalleryCredentials.Account account, int limit) {
        return Site.GELBOORU.endpoint("/index.php").appendQueryParameter("page", "dapi")
                .appendQueryParameter("s", type).appendQueryParameter("q", "index").appendQueryParameter("json", "1")
                .appendQueryParameter("limit", String.valueOf(limit)).appendQueryParameter("user_id", account.name)
                .appendQueryParameter("api_key", account.key);
    }

    private static String gelbooruPattern(String query) {
        String escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        return escaped.contains("*") ? escaped.replace('*', '%') : "%" + escaped + "%";
    }

    private Object requestJson(Site site, Uri.Builder endpoint, TagGalleryCredentials.Account account)
            throws IOException, JSONException {
        (site == Site.DANBOORU ? danbooruPace : gelbooruPace).awaitTurn();
        HttpURLConnection connection = connect(new URL(endpoint.build().toString()));
        connection.setRequestProperty("Accept", "application/json");
        if (site == Site.DANBOORU && account != null) {
            String login = account.name + ":" + account.key;
            connection.setRequestProperty("Authorization", "Basic " + Base64.encodeToString(
                    login.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        }
        try {
            int status = connection.getResponseCode();
            if (status != 200) throw httpFailure(status);
            if (connection.getContentLengthLong() > MAX_JSON) throw httpFailure(502);
            try (InputStream input = connection.getInputStream()) {
                return new JSONTokener(new String(NaxLibrary.readBounded(input, MAX_JSON), StandardCharsets.UTF_8)).nextValue();
            }
        } finally { connection.disconnect(); }
    }

    private static HttpURLConnection connect(URL url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", USER_AGENT);
        return connection;
    }

    private static JSONArray getRows(Object result, String key) throws Failure {
        if (result instanceof JSONArray) return (JSONArray) result;
        if (result instanceof JSONObject) {
            JSONObject object = (JSONObject) result;
            if (object.has("success") && !object.optBoolean("success", false)) throw httpFailure(502);
            JSONArray array = object.optJSONArray(key);
            if (array != null) return array;
            JSONObject only = object.optJSONObject(key);
            if (only != null) return new JSONArray().put(only);
            JSONObject attrs = object.optJSONObject("@attributes");
            if (attrs != null && attrs.optInt("count", -1) == 0) return new JSONArray();
        }
        throw httpFailure(502);
    }

    private JSONObject toPost(Site site, JSONObject row, String requestedRating) throws JSONException {
        long id = row.optLong("id", 0);
        String rating = normalizeRating(row.optString("rating", ""));
        if (id <= 0 || rating.isEmpty() || (!"all".equals(requestedRating) && !rating.equals(requestedRating))) return null;
        if (row.optBoolean("is_deleted") || row.optBoolean("is_banned")) return null;
        String ext = row.optString("file_ext", "").toLowerCase(Locale.ROOT);
        if ("mp4".equals(ext) || "webm".equals(ext) || "zip".equals(ext)) return null;
        URI thumbnail;
        URI preview;
        if (site == Site.DANBOORU) {
            thumbnail = firstImage(site, mediaVariant(row, "360x360"), row.optString("preview_file_url"));
            preview = firstImage(site, row.optString("large_file_url"), mediaVariant(row, "720x720"), row.optString("file_url"));
        } else {
            thumbnail = firstImage(site, row.optString("preview_url"));
            preview = firstImage(site, row.optString("sample_url"), row.optString("file_url"));
        }
        if (thumbnail == null && preview == null) return null;
        String thumbnailPath = thumbnail == null ? "" : registerImage(site, thumbnail, MAX_THUMB);
        String previewPath = preview == null ? thumbnailPath : registerImage(site, preview, MAX_PREVIEW);
        JSONArray tags = new JSONArray();
        Set<String> seenTags = new HashSet<>();
        if (site == Site.DANBOORU) {
            appendTags(tags, row.optString("tag_string_artist"), "画师", seenTags);
            appendTags(tags, row.optString("tag_string_copyright"), "作品", seenTags);
            appendTags(tags, row.optString("tag_string_character"), "角色", seenTags);
            appendTags(tags, row.optString("tag_string_general"), "通用", seenTags);
            appendTags(tags, row.optString("tag_string_meta"), "元数据", seenTags);
            appendTags(tags, row.optString("tag_string"), "", seenTags);
        } else appendTags(tags, row.optString("tags"), "", seenTags);
        return new JSONObject().put("id", id).put("thumbnail", thumbnailPath).put("preview", previewPath)
                .put("postUrl", site.postUrl(id)).put("rating", rating).put("score", row.optInt("score"))
                .put("width", row.optInt(site == Site.DANBOORU ? "image_width" : "width"))
                .put("height", row.optInt(site == Site.DANBOORU ? "image_height" : "height")).put("tags", tags);
    }

    private static String mediaVariant(JSONObject row, String name) {
        JSONObject asset = row.optJSONObject("media_asset");
        JSONArray variants = asset == null ? null : asset.optJSONArray("variants");
        if (variants != null) for (int i = 0; i < variants.length(); i++) {
            JSONObject item = variants.optJSONObject(i);
            if (item != null && name.equals(item.optString("type"))) return item.optString("url");
        }
        return "";
    }

    private static void appendTags(JSONArray tags, String value, String kind, Set<String> seen)
            throws JSONException {
        for (String name : value.split("\\s+")) {
            if (validTag(name) && seen.add(name)) {
                tags.put(new JSONObject().put("name", name).put("kind", kind));
            }
        }
    }

    private static boolean validTag(String name) {
        return !name.isEmpty() && name.length() <= 200 && !name.matches(".*[\\p{Cntrl}\\s].*");
    }

    private static String tagKind(String type) {
        switch (type) {
            case "1": case "artist": return "画师";
            case "3": case "copyright": return "作品";
            case "4": case "character": return "角色";
            case "5": case "meta": case "metadata": return "元数据";
            case "0": case "general": return "通用";
            default: return "";
        }
    }

    static String normalizeRating(String value) {
        switch (value.trim().toLowerCase(Locale.ROOT)) {
            case "g": case "safe": case "general": return "general";
            case "s": case "sensitive": return "sensitive";
            case "q": case "questionable": return "questionable";
            case "e": case "explicit": return "explicit";
            default: return "";
        }
    }

    private static int parsePage(String value) throws Failure {
        if (value == null) return 1;
        if (value.matches("[1-9][0-9]{0,3}")) {
            int page = Integer.parseInt(value);
            if (page <= MAX_PAGE) return page;
        }
        throw new Failure(400, "page", "页码超出范围。");
    }

    private static String checkedQuery(String value) throws Failure {
        if (value == null) return "";
        String query = value.trim();
        if (query.length() > 512 || query.matches(".*\\p{Cntrl}.*")) {
            throw new Failure(400, "query", "标签过长或包含无效字符。");
        }
        return query.replaceAll(" +", " ");
    }

    private static String postQuery(Site site, String query, String rating, boolean popular) {
        StringBuilder result = new StringBuilder();
        for (String term : query.split(" ")) {
            if (term.isEmpty() || term.matches("(?i)^[-~]?(?:rating|order|sort):.*")) continue;
            result.append(term).append(' ');
        }
        if (!"all".equals(rating)) result.append("rating:").append(rating).append(' ');
        if (popular) result.append(site == Site.DANBOORU ? "order:score" : "sort:score:desc");
        return result.toString().trim();
    }

    private static URI firstImage(Site site, String... urls) {
        for (String url : urls) {
            try {
                if (url.isEmpty() || url.length() > 1024) continue;
                URI uri = URI.create(url.startsWith("//") ? "https:" + url : url);
                if (allowsImage(site, uri)) return uri;
            } catch (IllegalArgumentException ignored) { /* Try the next preview size. */ }
        }
        return null;
    }

    private static boolean allowsImage(Site site, URI uri) {
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getPort() != -1
                || uri.getUserInfo() != null || uri.getRawFragment() != null) return false;
        String path = uri.getPath();
        if (path == null || !path.toLowerCase(Locale.ROOT).matches("/.*\\.(?:jpe?g|png|webp|gif)")) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (site == Site.DANBOORU) return "cdn.donmai.us".equals(host);
        return "gelbooru.com".equals(host) || host.matches("img[0-9]{1,2}\\.gelbooru\\.com");
    }

    private String registerImage(Site site, URI uri, int limit) {
        String token = UUID.randomUUID().toString();
        imageSources.put(token, new ImageSource(site, uri, limit));
        return "/" + IMAGE_ROUTE + "/" + token;
    }

    byte[] image(String token) throws IOException, InterruptedException {
        ImageSource source = imageSources.get(token);
        if (source == null) throw new IOException("Unknown gallery image");
        byte[] cached = imageCache.get(token);
        if (cached != null) return cached;
        if (!imageRequests.tryAcquire(8, TimeUnit.SECONDS)) throw new IOException("Too many gallery images loading");
        try {
            URI uri = source.uri;
            for (int redirects = 0; redirects < 4; redirects++) {
                if (!allowsImage(source.site, uri)) throw new IOException("Unknown gallery image host");
                HttpURLConnection connection = connect(uri.toURL());
                connection.setRequestProperty("Accept", "image/webp,image/png,image/jpeg,image/gif");
                try {
                    int status = connection.getResponseCode();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        String location = connection.getHeaderField("Location");
                        if (location == null) throw new IOException("Invalid image redirect");
                        uri = uri.resolve(location);
                        continue;
                    }
                    if (status != 200 || connection.getContentLengthLong() > source.limit) throw new IOException("Image unavailable");
                    try (InputStream input = connection.getInputStream()) {
                        byte[] bytes = NaxLibrary.readBounded(input, source.limit);
                        if (NaxLibrary.imageType(bytes) == null) throw new IOException("Unsupported gallery image");
                        if (bytes.length <= 2 * 1024 * 1024) imageCache.put(token, bytes);
                        return bytes;
                    }
                } finally { connection.disconnect(); }
            }
            throw new IOException("Too many redirects");
        } finally { imageRequests.release(); }
    }

    private static Failure httpFailure(int status) {
        switch (status) {
            case 400: case 422: return new Failure(status, "query", "站点无法执行此查询，请尝试减少标签。");
            case 401: return new Failure(401, "credentials", "站点需要有效的 API 凭据。");
            case 403: return new Failure(403, "forbidden", "站点拒绝了图库请求，可尝试在 App 内打开官网。");
            case 429: return new Failure(429, "rate-limit", "请求过多，请稍后重试。");
            default: return new Failure(502, "upstream", "站点暂时没有返回可用的图库数据。");
        }
    }
}
