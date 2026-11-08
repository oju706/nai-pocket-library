package app.nai.pocketlibrary;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** Reads local or online community style archives without unpacking them. */
final class SharedStylePacks {
    static final String ORIGINAL_ROUTE = "shared-style-image";
    static final String PREVIEW_ROUTE = "shared-style-thumb";
    static final String REMOTE_ORIGINAL_ROUTE = "remote-shared-style-image";
    static final String REMOTE_PREVIEW_ROUTE = "remote-shared-style-thumb";
    private static final URI ARTIST_CONFIG = URI.create(
            "https://raw.githubusercontent.com/oju706/nai-pocket-library/main/resource-packs/artist.json");
    private static final int MAX_INDEX = 4 * 1024 * 1024;
    private static final int MAX_IMAGE = 12 * 1024 * 1024;
    private static final int MAX_MODELS = 256 * 1024;
    private static final String MODELS_ASSET = "community-style-models.json";
    private static final String UNLABELED_MODEL = "未标注";
    private static final int READ = Intent.FLAG_GRANT_READ_URI_PERMISSION;
    private static final String SOURCE_PREFIX = "https://arca.live/b/aiart/";
    private final Context context;
    private final ContentResolver resolver;
    private final SharedPreferences saved;
    private final PackPhotoCache cache;
    private volatile Catalog current;
    private volatile Catalog remote;

    SharedStylePacks(Context context, PackPhotoCache cache) {
        this.context = context.getApplicationContext();
        resolver = this.context.getContentResolver();
        saved = this.context.getSharedPreferences("shared-style-pack", Context.MODE_PRIVATE);
        this.cache = cache;
    }

    JSONObject open() throws IOException, JSONException {
        Catalog catalog = current;
        if (catalog != null) return catalog.index;
        String previous = saved.getString("uri", "");
        if (previous.isEmpty()) return null;
        current = readCatalog(Uri.parse(previous));
        return current.index;
    }

    JSONObject openRemote() throws IOException, JSONException {
        byte[] configBytes = OnlinePacks.fetch(ARTIST_CONFIG, 16 * 1024);
        JSONObject config = new JSONObject(new String(configBytes, StandardCharsets.UTF_8));
        if (!"nai-pocket-resource-pack".equals(config.optString("format")) || config.optInt("version") != 1
                || !"artist".equals(config.optString("section")) || !"shared-style-zip".equals(config.optString("kind"))) {
            throw new IOException("默认资源仓库中的图包设置无效。");
        }
        SharedStyleRemote source = SharedStyleRemote.open(config.getString("source"), config.getLong("bytes"),
                config.getString("manifestSha256"));
        Catalog previous = remote;
        if (previous != null && source.sourceUrl.equals(previous.remote.sourceUrl)
                && source.size() == previous.remote.size() && source.manifestSha.equals(previous.remote.manifestSha)) {
            return previous.index;
        }
        Catalog next = readCatalog(null, source, source);
        remote = next;
        return next.index;
    }

    JSONObject mount(Uri uri) throws IOException, JSONException {
        Catalog next = readCatalog(uri);
        String previous = saved.getString("uri", "");
        boolean same = uri.toString().equals(previous);
        boolean owned = saved.getBoolean("owned", false);
        boolean alreadyGranted = resolver.getPersistedUriPermissions().stream()
                .anyMatch(permission -> permission.isReadPermission() && uri.equals(permission.getUri()));
        if (!alreadyGranted) resolver.takePersistableUriPermission(uri, READ);
        if (!saved.edit().putString("uri", uri.toString()).putBoolean("owned", !alreadyGranted || (same && owned)).commit()) {
            if (!alreadyGranted) release(uri);
            throw new IOException("无法保存图包位置。");
        }
        current = next;
        if (owned && !same && !previous.isEmpty()) release(Uri.parse(previous));
        return next.index;
    }

    void forget() throws IOException {
        String uri = saved.getString("uri", "");
        boolean owned = saved.getBoolean("owned", false);
        if (!saved.edit().clear().commit()) throw new IOException("无法移除图包位置。");
        current = null;
        if (owned && !uri.isEmpty()) release(Uri.parse(uri));
    }

    private void release(Uri uri) {
        try { resolver.releasePersistableUriPermission(uri, READ); }
        catch (SecurityException ignored) { /* A moved file may no longer have a grant. */ }
    }

    private Catalog readCatalog(Uri uri) throws IOException, JSONException {
        try (ParcelFileDescriptor.AutoCloseInputStream input = openFile(uri)) {
            return readCatalog(uri, null, SharedStyleZip.channel(input.getChannel()));
        }
    }

    private Catalog readCatalog(Uri uri, SharedStyleRemote online, SharedStyleZip.Source source) throws IOException, JSONException {
        SharedStyleZip archive = SharedStyleZip.open(source);
        SharedStyleZip.Entry manifest = archive.get("manifest.json");
        if (manifest == null && online == null && archive.get("batch.json") != null) {
            return readTestCatalog(uri, archive, source);
        }
        if (manifest == null) throw new IOException("ZIP 中没有社区画风图包目录。");
        byte[] raw = archive.read(source, manifest, MAX_INDEX);
        String digest = OnlinePacks.hex(OnlinePacks.sha256().digest(raw));
        if (online != null && !online.manifestSha.equals(digest)) throw new IOException("在线图包与仓库目录校验不一致。");
        JSONObject data = new JSONObject(new String(raw, StandardCharsets.UTF_8));
        JSONArray files = data.getJSONArray("files");
        if (!"naimakeartistgroup-shared-images".equals(data.optString("format")) || data.optInt("version") != 2
                || files.length() < 1 || files.length() > 10000 || files.length() != data.optInt("file_count")) {
            throw new IOException("请选择 NAImakeArtistGroup 的社区画风图包 ZIP。");
        }
        String revision = online == null ? digest : OnlinePacks.hex(OnlinePacks.sha256()
                .digest((online.sourceUrl + "\n" + digest).getBytes(StandardCharsets.UTF_8)));
        String previewRoute = online == null ? PREVIEW_ROUTE : REMOTE_PREVIEW_ROUTE;
        String originalRoute = online == null ? ORIGINAL_ROUTE : REMOTE_ORIGINAL_ROUTE;
        Map<String, String> models = readModels(digest);
        JSONArray images = new JSONArray();
        Map<String, Photo> photos = new LinkedHashMap<>();
        for (int i = 0; i < files.length(); i++) {
            JSONObject row = files.getJSONObject(i);
            String id = row.getString("image_id");
            String name = row.getString("name");
            String sha = row.getString("sha256");
            String post = row.getString("source_url");
            if (!id.matches("[0-9]{1,16}") || !name.matches("[a-f0-9]{64}\\.webp")
                    || !sha.matches("[a-f0-9]{64}") || !post.startsWith(SOURCE_PREFIX)) throw invalidRow(i);
            String postId = post.substring(SOURCE_PREFIX.length());
            SharedStyleZip.Entry file = archive.get("arca_style_images/" + name);
            if (!postId.matches("[0-9]{1,16}") || photos.containsKey(id) || file == null
                    || file.bytes < 12 || file.bytes > MAX_IMAGE || file.bytes != row.optLong("bytes")) throw invalidRow(i);
            photos.put(id, new Photo(file, sha));
            String path = "/" + revision + "/" + id;
            images.put(new JSONObject().put("id", id).put("title", "原帖 " + postId + " · 图 " + id)
                    .put("section", "artist").put("rating", "unknown")
                    .put("model", models.getOrDefault(id, UNLABELED_MODEL))
                    .put("bytes", file.bytes).put("source", post).put("postId", postId)
                    .put("thumbnail", "/" + previewRoute + path).put("original", "/" + originalRoute + path));
        }
        JSONObject index = new JSONObject().put("title", "Arca Live 社区画风合集")
                .put("revision", revision).put("images", images);
        if (online != null) index.put("downloadUrl", online.sourceUrl);
        return new Catalog(uri, online, archive, revision, photos, index);
    }

    private Catalog readTestCatalog(Uri uri, SharedStyleZip archive, SharedStyleZip.Source source) throws IOException, JSONException {
        SharedStyleTestCatalog test = SharedStyleTestCatalog.read(archive, source);
        Map<String, Photo> photos = new LinkedHashMap<>();
        JSONArray images = new JSONArray();
        for (SharedStyleTestCatalog.Item item : test.items) {
            photos.put(item.id, new Photo(item.original, item.thumbnail, item.mime));
            String postId = item.source.isEmpty() ? "" : item.source.substring(SOURCE_PREFIX.length());
            String path = "/" + test.revision + "/" + item.id;
            images.put(new JSONObject().put("id", item.id).put("title", item.title)
                    .put("section", "artist").put("rating", "unknown").put("model", item.model)
                    .put("bytes", item.original.bytes).put("source", item.source).put("postId", postId)
                    .put("thumbnail", "/" + PREVIEW_ROUTE + path).put("original", "/" + ORIGINAL_ROUTE + path));
        }
        JSONObject index = new JSONObject().put("title", test.title).put("revision", test.revision).put("images", images);
        return new Catalog(uri, null, archive, test.revision, photos, index);
    }

    private Map<String, String> readModels(String manifestSha) {
        try (InputStream input = context.getAssets().open(MODELS_ASSET)) {
            byte[] raw = NaxLibrary.readBounded(input, MAX_MODELS);
            JSONObject root = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            Object boundManifest = root.opt("manifestSha256");
            if (!"nai-pocket-community-models".equals(root.optString("format"))
                    || root.optInt("version") != 1 || !(boundManifest instanceof String)
                    || !manifestSha.equals(boundManifest)) {
                return Collections.emptyMap();
            }
            JSONObject values = root.optJSONObject("models");
            if (values == null) return Collections.emptyMap();
            Map<String, String> models = new LinkedHashMap<>();
            Iterator<String> ids = values.keys();
            while (ids.hasNext()) {
                String id = ids.next();
                Object value = values.opt(id);
                if (!id.matches("[0-9]{1,16}") || !(value instanceof String)
                        || ((String) value).trim().isEmpty()) {
                    return Collections.emptyMap();
                }
                models.put(id, (String) value);
            }
            return models;
        } catch (IOException | JSONException failure) {
            return Collections.emptyMap();
        }
    }

    byte[] photo(String revision, String id, boolean thumbnail, boolean online) throws IOException {
        Catalog catalog = catalog(revision, online);
        Photo photo = catalog.photos.get(id);
        if (thumbnail && photo != null && photo.thumbnail != null) {
            try (ParcelFileDescriptor.AutoCloseInputStream input = openFile(catalog.uri)) {
                byte[] preview = catalog.archive.read(input.getChannel(), photo.thumbnail, 512 * 1024);
                if ("image/jpeg".equals(NaxLibrary.imageType(preview))) return preview;
            }
        }
        byte[] bytes = original(catalog, id);
        if (!thumbnail) return bytes;
        Bitmap image = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes)), (decoder, info, source) -> {
            int width = info.getSize().getWidth();
            int height = info.getSize().getHeight();
            double scale = Math.min(1, 420.0 / Math.max(width, height));
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            decoder.setTargetSize(Math.max(1, (int) (width * scale)), Math.max(1, (int) (height * scale)));
        });
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!image.compress(Bitmap.CompressFormat.JPEG, 76, output)) throw new IOException("无法生成缩略图。");
            return output.toByteArray();
        } finally {
            image.recycle();
        }
    }

    OnlinePacks.Export prepareExport(String request, File cache, boolean online) throws IOException, JSONException {
        JSONObject selection = new JSONObject(request);
        Catalog catalog = catalog(selection.getString("revision"), online);
        return OnlinePacks.export(selection, cache, id -> {
            Photo image = catalog.photos.get(id);
            return image == null ? 0 : image.entry.bytes;
        }, id -> original(catalog, id));
    }

    private byte[] original(Catalog catalog, String id) throws IOException {
        Photo photo = catalog.photos.get(id);
        if (photo == null) throw new IOException("这张图片不在已选图包中。");
        if (catalog.remote != null) {
            byte[] cached = cache.get(photo.sha, photo.entry.bytes);
            if (cached != null && "image/webp".equals(NaxLibrary.imageType(cached))
                    && OnlinePacks.matchesDigest(cached, photo.sha)) return cached;
            byte[] data = original(catalog, photo, catalog.remote);
            cache.put(photo.sha, data);
            return data;
        }
        try (ParcelFileDescriptor.AutoCloseInputStream input = openFile(catalog.uri)) {
            return original(catalog, photo, SharedStyleZip.channel(input.getChannel()));
        }
    }

    private byte[] original(Catalog catalog, Photo photo, SharedStyleZip.Source source) throws IOException {
        byte[] bytes = catalog.archive.read(source, photo.entry, MAX_IMAGE);
        if (!photo.mime.equals(NaxLibrary.imageType(bytes))
                || (photo.sha != null && !OnlinePacks.matchesDigest(bytes, photo.sha))) {
            throw new IOException("图片与图包目录不符，请重新检查图包。");
        }
        return bytes;
    }

    private ParcelFileDescriptor.AutoCloseInputStream openFile(Uri uri) throws IOException {
        if (!"content".equals(uri.getScheme())) throw new IOException("请从安卓文件窗口选择本地 ZIP。");
        try {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "r");
            if (descriptor != null) return new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
        } catch (IOException | SecurityException failure) {
            throw new IOException("原 ZIP 无法打开，请确认文件仍在手机并重新选择。", failure);
        }
        throw new IOException("原 ZIP 无法打开，请重新选择。");
    }

    private Catalog catalog(String revision, boolean online) throws IOException {
        Catalog catalog = online ? remote : current;
        if (catalog == null || !catalog.revision.equals(revision)) throw new IOException("图包已更换，请重新打开。");
        return catalog;
    }

    private static IOException invalidRow(int index) {
        return new IOException("社区图包第 " + (index + 1) + " 张图片与目录不符。");
    }

    private static final class Catalog {
        final Uri uri;
        final SharedStyleRemote remote;
        final SharedStyleZip archive;
        final String revision;
        final Map<String, Photo> photos;
        final JSONObject index;
        Catalog(Uri uri, SharedStyleRemote remote, SharedStyleZip archive, String revision, Map<String, Photo> photos, JSONObject index) {
            this.uri = uri;
            this.remote = remote;
            this.archive = archive;
            this.revision = revision;
            this.photos = photos;
            this.index = index;
        }
    }

    private static final class Photo {
        final SharedStyleZip.Entry entry;
        final SharedStyleZip.Entry thumbnail;
        final String sha;
        final String mime;

        Photo(SharedStyleZip.Entry entry, String sha) {
            this.entry = entry;
            this.thumbnail = null;
            this.sha = sha;
            this.mime = "image/webp";
        }

        Photo(SharedStyleZip.Entry entry, SharedStyleZip.Entry thumbnail, String mime) {
            this.entry = entry;
            this.thumbnail = thumbnail;
            this.sha = null;
            this.mime = mime;
        }
    }
}
