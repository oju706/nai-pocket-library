package app.nai.pocketlibrary;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.ToIntFunction;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import javax.net.ssl.HttpsURLConnection;

/** Reads an image catalog and individual verified originals from a public GitHub repository. */
final class OnlinePacks {
    private static final String HOST = "raw.githubusercontent.com";
    private static final String INDEX = "online-pack.json";
    private static final String GALLERY_INDEX =
            "https://raw.githubusercontent.com/oju706/nai-pocket-library/main/resource-packs/galleries.json";
    private static final int MAX_INDEX = 1024 * 1024;
    private static final int MAX_GALLERY_INDEX = 64 * 1024;
    private static final int MAX_GALLERY_PACKS = 32;
    private static final int MAX_THUMB = 512 * 1024;
    private static final int MAX_IMAGE = 12 * 1024 * 1024;
    private static final int MAX_BATCH = 20;
    private static final int MAX_EXPORT = 32 * 1024 * 1024;
    private static final String EXPORT_PREFIX = "pocket-online-export-";
    private static final String IMAGE_ROUTE = "/online-pack-image/";
    private static final String THUMB_ROUTE = "/online-pack-thumb/";
    private final PackPhotoCache cache;
    private volatile Catalog current;

    OnlinePacks(PackPhotoCache cache) { this.cache = cache; }

    JSONObject galleryIndex() throws IOException, JSONException {
        URI url = URI.create(GALLERY_INDEX);
        byte[] manifest = fetch(url, MAX_GALLERY_INDEX);
        JSONObject input = new JSONObject(new String(manifest, StandardCharsets.UTF_8));
        if (!"nai-pocket-gallery-index".equals(input.optString("format")) || input.optInt("version") != 1) {
            throw new IOException("远程图库入口清单格式不正确。");
        }
        JSONArray packs = input.optJSONArray("packs");
        if (packs == null || packs.length() < 1 || packs.length() > MAX_GALLERY_PACKS) {
            throw new IOException("远程图库入口清单必须包含 1 至 32 个入口。");
        }
        JSONArray rows = new JSONArray();
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < packs.length(); i++) {
            JSONObject pack = packs.getJSONObject(i);
            String id = pack.optString("id", "").trim();
            String title = pack.optString("title", "").trim();
            String section = pack.optString("section", "");
            String address = pack.optString("address", "").trim();
            String defaultRating = pack.optString("defaultRating", "unknown");
            if (!id.matches("[A-Za-z0-9_-]{1,64}") || !ids.add(id)
                    || title.isEmpty() || title.length() > 120 || unsafeText(title)
                    || (!"artist".equals(section) && !"character".equals(section) && !"knowledge".equals(section))
                    || (!"sfw".equals(defaultRating) && !"nsfw".equals(defaultRating) && !"unknown".equals(defaultRating))) {
                throw new IOException("远程图库入口清单第 " + (i + 1) + " 项格式不正确。");
            }
            indexUri(address);
            rows.put(new JSONObject().put("id", id).put("title", title).put("section", section)
                    .put("address", address).put("defaultRating", defaultRating));
        }
        return new JSONObject().put("format", "nai-pocket-gallery-index").put("version", 1).put("packs", rows);
    }

    JSONObject open(String address) throws IOException, JSONException {
        URI url = indexUri(address);
        byte[] manifest = fetch(url, MAX_INDEX);
        JSONObject input = new JSONObject(new String(manifest, StandardCharsets.UTF_8));
        if (!"nai-pocket-online-pack".equals(input.optString("format")) || input.optInt("version") != 1) {
            throw new IOException("这个目录不是支持的在线图包格式。");
        }
        JSONArray images = input.getJSONArray("images");
        if (images.length() > 2000) throw new IOException("每个在线目录最多包含 2,000 张图。");
        String revision = hex(sha256().digest((url + "\n" + hex(sha256().digest(manifest))).getBytes(StandardCharsets.UTF_8)));
        String title = text(input, "title", "在线图包", 120);
        Catalog catalog = new Catalog(revision, url.resolve("."));
        JSONArray rows = new JSONArray();
        for (int i = 0; i < images.length(); i++) {
            JSONObject row = images.getJSONObject(i);
            String id = row.optString("id");
            String digest = row.optString("sha256");
            long bytes = row.optLong("bytes");
            if (!id.matches("[A-Za-z0-9_-]{1,64}") || catalog.items.containsKey(id)
                    || !digest.matches("[0-9a-fA-F]{64}") || bytes < 1 || bytes > MAX_IMAGE) {
                throw new IOException("在线目录第 " + (i + 1) + " 张图片的编号、大小或校验值不正确。");
            }
            Image image = new Image(id, assetPath(row.getString("original")), assetPath(row.getString("thumbnail")),
                    (int) bytes, digest.toLowerCase(Locale.ROOT));
            catalog.items.put(id, image);
            String section = row.optString("section");
            if (!"character".equals(section) && !"knowledge".equals(section)) section = "artist";
            String rating = row.optString("rating");
            if (!"sfw".equals(rating) && !"nsfw".equals(rating)) rating = "unknown";
            rows.put(new JSONObject().put("id", id).put("title", text(row, "title", id, 200))
                    .put("model", text(row, "model", "未标注", 40)).put("section", section).put("rating", rating)
                    .put("source", text(row, "source", title, 160)).put("bytes", image.bytes)
                    .put("thumbnail", THUMB_ROUTE + revision + "/" + id)
                    .put("original", IMAGE_ROUTE + revision + "/" + id));
        }
        JSONObject result = new JSONObject().put("title", title).put("revision", revision).put("images", rows);
        current = catalog;
        return result;
    }

    byte[] photo(String revision, String id, boolean thumbnail) throws IOException {
        Catalog catalog = catalog(revision);
        Image image = catalog.items.get(id);
        if (image == null) throw new IOException("这张图已不在当前图包。");
        if (!thumbnail) return original(catalog, image);
        byte[] bytes = fetch(catalog.base.resolve(image.thumbnail), MAX_THUMB);
        if (!supportedImage(bytes)) throw new IOException("缩略图格式不正确。");
        return bytes;
    }

    Export prepareExport(String request, File cache) throws IOException, JSONException {
        JSONObject selection = new JSONObject(request);
        Catalog catalog = catalog(selection.getString("revision"));
        return export(selection, cache, id -> {
            Image image = catalog.items.get(id);
            return image == null ? 0 : image.bytes;
        }, id -> original(catalog, catalog.items.get(id)));
    }

    static Export export(JSONObject selection, File cache, ToIntFunction<String> size,
                         PhotoReader reader) throws IOException, JSONException {
        JSONArray ids = selection.getJSONArray("ids");
        if (ids.length() < 1 || ids.length() > MAX_BATCH) throw new IOException("每次请选择 1 至 20 张图片。");
        List<String> selected = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        long total = 0;
        for (int i = 0; i < ids.length(); i++) {
            String id = ids.getString(i);
            int length = size.applyAsInt(id);
            if (length < 1 || !id.matches("[A-Za-z0-9_-]{1,64}") || !seen.add(id)) {
                throw new IOException("所选图片无效，请重新选择。");
            }
            total += length;
            if (total > MAX_EXPORT) throw new IOException("每次最多保存 32 MiB 原图，请分批选择。");
            selected.add(id);
        }
        File stage = File.createTempFile(EXPORT_PREFIX, ".tmp", cache);
        boolean ready = false;
        try {
            Export result;
            if (selected.size() == 1) {
                String id = selected.get(0);
                byte[] data = reader.read(id);
                String mime = NaxLibrary.imageType(data);
                try (FileOutputStream output = new FileOutputStream(stage)) {
                    output.write(data);
                }
                result = new Export(stage, id + extension(mime), mime);
            } else {
                try (ZipOutputStream output = new ZipOutputStream(new FileOutputStream(stage))) {
                    for (String id : selected) {
                        byte[] data = reader.read(id);
                        output.putNextEntry(new ZipEntry(id + extension(NaxLibrary.imageType(data))));
                        output.write(data);
                        output.closeEntry();
                    }
                }
                result = new Export(stage, "NAI-所选原图.zip", "application/zip");
            }
            ready = true;
            return result;
        } finally {
            if (!ready) stage.delete();
        }
    }

    static void clearExpiredExports(File cache) {
        File[] exports = cache.listFiles((directory, name) -> name.startsWith(EXPORT_PREFIX) && name.endsWith(".tmp"));
        if (exports == null) return;
        long cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L;
        for (File export : exports) {
            if (export.isFile() && export.lastModified() < cutoff) export.delete();
        }
    }

    private Catalog catalog(String revision) throws IOException {
        Catalog catalog = current;
        if (catalog == null || !catalog.revision.equals(revision)) throw new IOException("图包目录已变化，请重新打开。");
        return catalog;
    }

    private byte[] original(Catalog catalog, Image image) throws IOException {
        byte[] cached = cache.get(image.digest, image.bytes);
        if (cached != null && matchesDigest(cached, image.digest) && supportedImage(cached)) return cached;
        byte[] bytes = fetch(catalog.base.resolve(image.original), image.bytes);
        if (bytes.length != image.bytes || !matchesDigest(bytes, image.digest) || !supportedImage(bytes)) {
            throw new IOException("原图与目录校验不一致，请检查资源更新。");
        }
        cache.put(image.digest, bytes);
        return bytes;
    }

    static boolean matchesDigest(byte[] data, String digest) {
        return hex(sha256().digest(data)).equals(digest);
    }

    static URI indexUri(String address) throws IOException {
        String value = address == null ? "" : address.trim();
        if (!value.startsWith("https://" + HOST + "/")) {
            try {
                String repo = AppUpdates.normalizeRepository(value);
                if (repo.isEmpty()) throw new IllegalArgumentException();
                value = "https://" + HOST + "/" + repo + "/main/" + INDEX;
            } catch (IllegalArgumentException failure) {
                throw new IOException("请输入公开的 GitHub 仓库地址或 online-pack.json 的 Raw 链接。");
            }
        }
        try {
            URI uri = new URI(value);
            if (value.length() > 1024 || !secureRaw(uri)) throw new IllegalArgumentException();
            String[] parts = uri.getRawPath().substring(1).split("/", -1);
            if (parts.length < 4 || !INDEX.equals(parts[parts.length - 1])) throw new IllegalArgumentException();
            for (String part : parts) if (!safeSegment(part)) throw new IllegalArgumentException();
            return uri;
        } catch (URISyntaxException | IllegalArgumentException failure) {
            throw new IOException("请输入 GitHub 上 online-pack.json 的有效 Raw 链接。");
        }
    }

    static String assetPath(String path) throws IOException {
        if (path == null || path.length() > 500 || !path.toLowerCase(Locale.ROOT).matches(".*\\.(webp|png|jpe?g)")) {
            throw new IOException("在线图包仅支持相对路径的 WebP、PNG 和 JPEG 图片。");
        }
        for (String part : path.split("/", -1)) {
            if (!safeSegment(part)) throw new IOException("在线图包图片路径无效。");
        }
        return path;
    }

    private static boolean safeSegment(String segment) {
        return segment.matches("[A-Za-z0-9_.-]{1,128}") && !".".equals(segment) && !"..".equals(segment);
    }

    private static boolean unsafeText(String value) {
        for (int i = 0; i < value.length(); i++) if (Character.isISOControl(value.charAt(i))) return true;
        return false;
    }

    private static boolean secureRaw(URI uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == -1
                && uri.getUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null
                && uri.getRawPath() != null && uri.getRawPath().startsWith("/");
    }

    static byte[] fetch(URI url, int limit) throws IOException {
        if (!secureRaw(url)) throw new IOException("在线图包仅从 GitHub Raw 读取。");
        HttpsURLConnection connection = (HttpsURLConnection) url.toURL().openConnection();
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("User-Agent", "NAI-Pocket-Library");
        try {
            if (Thread.currentThread().isInterrupted()) throw new IOException("下载已停止。");
            int status = connection.getResponseCode();
            if (status == 404) throw new IOException("GitHub 找不到图包目录或图片，请确认仓库已公开且文件存在。");
            if (status != 200) throw new IOException("GitHub 返回 HTTP " + status + "。");
            if (connection.getContentLengthLong() > limit) throw new IOException("在线资源超过允许大小。");
            try (InputStream input = connection.getInputStream()) {
                return NaxLibrary.readBounded(input, limit);
            }
        } finally {
            connection.disconnect();
        }
    }

    private static String text(JSONObject item, String name, String fallback, int limit) {
        String value = item.optString(name, "").trim();
        return value.isEmpty() ? fallback : value.substring(0, Math.min(value.length(), limit));
    }

    private static String extension(String mime) {
        return "image/png".equals(mime) ? ".png" : "image/jpeg".equals(mime) ? ".jpg" : ".webp";
    }

    private static boolean supportedImage(byte[] bytes) {
        String mime = NaxLibrary.imageType(bytes);
        return "image/png".equals(mime) || "image/jpeg".equals(mime) || "image/webp".equals(mime);
    }

    static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException unavailable) { throw new AssertionError(unavailable); }
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(Character.forDigit((value >>> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
        return result.toString();
    }

    private static final class Catalog {
        final String revision;
        final URI base;
        final Map<String, Image> items = new LinkedHashMap<>();
        Catalog(String revision, URI base) { this.revision = revision; this.base = base; }
    }

    private static final class Image {
        final String id, original, thumbnail, digest;
        final int bytes;
        Image(String id, String original, String thumbnail, int bytes, String digest) {
            this.id = id;
            this.original = original;
            this.thumbnail = thumbnail;
            this.bytes = bytes;
            this.digest = digest;
        }
    }

    static final class Export {
        final File file;
        final String name, mime;
        Export(File file, String name, String mime) { this.file = file; this.name = name; this.mime = mime; }
    }

    interface PhotoReader {
        byte[] read(String id) throws IOException;
    }
}
