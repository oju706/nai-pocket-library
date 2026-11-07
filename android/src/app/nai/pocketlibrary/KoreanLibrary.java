package app.nai.pocketlibrary;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.AtomicFile;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A bundled offset index over the author's original JSON. The large JSON is never downloaded. */
final class KoreanLibrary {
    private static final String SOURCE_URL = "https://huggingface.co/baqu2213/PoemForSmallFThings/resolve/main/NAIA/NAID5_artist_thumbnail/NAID5-33000-55000-Curated";
    private static final String PINNED_URL = "https://huggingface.co/baqu2213/PoemForSmallFThings/resolve/3f9a156edc9cee75f579bd25a22ee98ab47dec52/NAIA/NAID5_artist_thumbnail/NAID5-33000-55000-Curated";
    private static final int MAX_IMAGE = 6 * 1024 * 1024;
    private static final long CACHE_BUDGET = 64L * 1024 * 1024;
    private static final Pattern RANGE = Pattern.compile("bytes ([0-9]+)-([0-9]+)/([0-9]+)");
    private static final String CHANGED = "韩国主库的原文件已变化。旧图片位置已停用，请更新索引或应用后再试。";
    private final Context context;
    private final File previews;
    private final SharedPreferences preferences;
    private final Semaphore downloads = new Semaphore(3);
    private Configuration configuration;
    private volatile boolean changed;
    private volatile State state = new State("failed", "尚未联网核对韩国主库，可点击检查资源更新。", false);

    KoreanLibrary(Context context) {
        this.context = context.getApplicationContext();
        previews = new File(context.getCacheDir(), "korean-previews-v1");
        preferences = context.getSharedPreferences("korean-source", Context.MODE_PRIVATE);
    }

    private synchronized Configuration configuration() throws IOException {
        if (configuration != null) return configuration;
        try (InputStream input = context.getAssets().open("korean-index.json")) {
            byte[] bytes = NaxLibrary.readBounded(input, 4 * 1024 * 1024);
            configuration = parseConfiguration(bytes);
            changed = configuration.identity.equals(preferences.getString("invalidSource", ""));
            if (changed) state = new State("changed", CHANGED, true);
            return configuration;
        } catch (JSONException failure) {
            throw new IOException("韩国主库目录无法读取，请重新安装应用。", failure);
        }
    }

    InputStream openIndex() throws IOException {
        return new ByteArrayInputStream(configuration().json);
    }

    static Configuration parseConfiguration(byte[] bytes) throws JSONException, IOException {
        JSONObject index = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        if (!"nai-pocket-korean-index".equals(index.optString("format")) || index.optInt("version") != 1) {
            throw new IOException("Unsupported Korean index");
        }
        JSONObject source = index.getJSONObject("source");
        String url = source.getString("url");
        long length = source.getLong("bytes");
        String etag = source.getString("etag");
        if ((!SOURCE_URL.equals(url) && !PINNED_URL.equals(url)) || length <= 0 || !etag.matches("\"[a-fA-F0-9]{64}\"")) {
            throw new IOException("Invalid Korean source identity");
        }
        Map<Long, Integer> positions = new HashMap<>();
        JSONArray artists = index.getJSONArray("artists");
        if (artists.length() == 0 || artists.length() > 60000) throw new IOException("Invalid artist count");
        int entries = 0;
        for (int i = 0; i < artists.length(); i++) {
            JSONArray artist = artists.getJSONArray(i);
            String name = artist.getString(0);
            if (name.length() > 400 || name.isEmpty()) throw new IOException("Invalid artist name");
            JSONArray photos = artist.getJSONArray(1);
            if (photos.length() == 0 || photos.length() > 50) throw new IOException("Invalid preview count");
            for (int j = 0; j < photos.length(); j++) {
                JSONArray photo = photos.getJSONArray(j);
                long offset = photo.getLong(0);
                int size = photo.getInt(1);
                if (!validSpan(offset, size, length) || ++entries > 120000) throw new IOException("Invalid image span");
                Integer old = positions.put(offset, size);
                if (old != null && old != size) throw new IOException("Conflicting image spans");
            }
        }
        return new Configuration(bytes, url, length, etag, positions);
    }

    static boolean validSpan(long offset, int size, long total) {
        return offset > 0 && size > 0 && size <= MAX_IMAGE && offset <= total - size;
    }

    Preview preview(long offset, int size) throws IOException {
        Configuration config = configuration();
        Integer allowed = config.positions.get(offset);
        if (allowed == null || allowed != size) throw new IOException("Image span is not in the bundled index");
        if (changed) throw new IOException(CHANGED);
        String key = UUID.nameUUIDFromBytes((config.identity + "/" + offset + "/" + size).getBytes(StandardCharsets.UTF_8)).toString();
        File cache = new File(previews, key + ".image");
        byte[] bytes = readCached(cache);
        if (bytes != null) {
            if (changed) throw new IOException(CHANGED);
            return new Preview(bytes);
        }
        try {
            downloads.acquire();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("读取已取消。", interrupted);
        }
        try {
            if (changed) throw new IOException(CHANGED);
            // Other requests may have filled the cache while this one waited for a slot.
            bytes = readCached(cache);
            if (bytes == null) {
                byte[] encoded = range(config, offset, size);
                bytes = decodeImage(encoded);
                if (changed) throw new IOException(CHANGED);
                try { writeCached(cache, bytes); }
                catch (IOException ignored) { /* A full cache must not block an otherwise valid preview. */ }
            }
            if (!changed) state = new State("current", "当前原文件与内置目录一致，图片按需读取。", true);
            if (changed) throw new IOException(CHANGED);
            return new Preview(bytes);
        } finally {
            downloads.release();
        }
    }

    JSONObject status(boolean check) {
        try {
            Configuration config = configuration();
            if (check) {
                range(config, 0, 1);
                changed = false;
                preferences.edit().remove("invalidSource").apply();
                state = new State("current", "韩国主库原文件与当前目录一致，无需更新。", true);
            }
        } catch (IOException failure) {
            if (changed) state = new State("changed", CHANGED, true);
            else state = new State("failed", "暂时无法核对韩国主库。请检查网络后重试，未下载完整资源包。", false);
        }
        State snapshot = state;
        try {
            return new JSONObject().put("status", snapshot.status).put("message", snapshot.message).put("checked", snapshot.checked);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private byte[] range(Configuration config, long offset, int size) throws IOException {
        URL url = new URL(config.url);
        long last = offset + size - 1;
        for (int redirects = 0; redirects <= 4; redirects++) {
            if (!allowedUrl(url)) throw new IOException("Unexpected preview host");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("Range", "bytes=" + offset + "-" + last);
            connection.setRequestProperty("If-Range", config.etag);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", "NAI-Pocket-Library/1.1");
            try {
                int code = connection.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String linkedSize = connection.getHeaderField("X-Linked-Size");
                    if (linkedSize != null && !linkedSize.equals(Long.toString(config.bytes))) throw sourceChanged(config);
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirects == 4) throw new IOException("Invalid preview redirect");
                    url = new URL(url, location);
                    continue;
                }
                String etag = connection.getHeaderField("ETag");
                if ((code == 200 || code == 206) && etag != null && !config.etag.equals(etag.trim())) throw sourceChanged(config);
                if (code == 412 || code == 416) throw sourceChanged(config);
                // Never open the response body when a server ignores Range and offers the entire file.
                if (code != 206) throw new IOException("Server did not return a partial image");
                if (etag == null) throw new IOException("Missing source fingerprint");
                Matcher match = RANGE.matcher(value(connection.getHeaderField("Content-Range")));
                if (!match.matches()) throw new IOException("Invalid range response");
                long first;
                long end;
                long total;
                try {
                    first = Long.parseLong(match.group(1));
                    end = Long.parseLong(match.group(2));
                    total = Long.parseLong(match.group(3));
                } catch (NumberFormatException failure) {
                    throw new IOException("Invalid range numbers", failure);
                }
                if (total != config.bytes) throw sourceChanged(config);
                if (first != offset || end != last) throw new IOException("Unexpected image range");
                String encoding = connection.getHeaderField("Content-Encoding");
                if (encoding != null && !"identity".equalsIgnoreCase(encoding)) throw new IOException("Unexpected transfer encoding");
                long contentLength = connection.getContentLengthLong();
                if (contentLength != -1 && contentLength != size) throw new IOException("Unexpected image length");
                try (InputStream input = connection.getInputStream()) {
                    byte[] bytes = NaxLibrary.readBounded(input, size);
                    if (bytes.length != size) throw new IOException("Incomplete image range");
                    return bytes;
                }
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many preview redirects");
    }

    static boolean allowedUrl(URL url) {
        return "https".equals(url.getProtocol()) && url.getUserInfo() == null && url.getRef() == null
                && (url.getPort() == -1 || url.getPort() == 443)
                && ("huggingface.co".equals(url.getHost()) || "us.aws.cdn.hf.co".equals(url.getHost()));
    }

    static byte[] decodeImage(byte[] encoded) throws IOException {
        if (encoded.length > MAX_IMAGE) throw new IOException("Image range is too large");
        String raw = new String(encoded, StandardCharsets.UTF_8);
        try {
            JSONTokener parser = new JSONTokener("\"" + raw + "\"");
            Object parsed = parser.nextValue();
            if (!(parsed instanceof String) || parser.nextClean() != 0) throw new IOException("Invalid image string");
            String base64 = (String) parsed;
            if (base64.startsWith("data:")) {
                int comma = base64.indexOf(',');
                if (comma < 0 || comma > 80 || !base64.substring(0, comma).endsWith(";base64")) throw new IOException("Invalid image data");
                base64 = base64.substring(comma + 1);
            }
            byte[] image = Base64.decode(base64, Base64.DEFAULT);
            if (image.length > MAX_IMAGE || NaxLibrary.imageType(image) == null) throw new IOException("Invalid preview image");
            return image;
        } catch (JSONException | IllegalArgumentException failure) {
            throw new IOException("Could not decode preview", failure);
        }
    }

    private synchronized byte[] readCached(File cache) {
        if (!cache.isFile()) return null;
        try (InputStream input = new AtomicFile(cache).openRead()) {
            byte[] bytes = NaxLibrary.readBounded(input, MAX_IMAGE);
            if (NaxLibrary.imageType(bytes) == null) return null;
            cache.setLastModified(System.currentTimeMillis());
            return bytes;
        } catch (IOException failure) {
            return null;
        }
    }

    private synchronized void writeCached(File cache, byte[] bytes) throws IOException {
        if (!previews.isDirectory() && !previews.mkdirs()) return;
        AtomicFile target = new AtomicFile(cache);
        FileOutputStream output = target.startWrite();
        try {
            output.write(bytes);
            target.finishWrite(output);
        } catch (IOException failure) {
            target.failWrite(output);
            throw failure;
        }
        File[] items = previews.listFiles(file -> file.getName().endsWith(".image"));
        if (items == null) return;
        long size = 0;
        for (File file : items) size += file.length();
        if (size <= CACHE_BUDGET) return;
        Arrays.sort(items, Comparator.comparingLong(File::lastModified));
        for (File file : items) {
            if (size <= CACHE_BUDGET) break;
            long length = file.length();
            if (!file.equals(cache) && file.delete()) size -= length;
        }
    }

    private IOException sourceChanged(Configuration config) {
        changed = true;
        preferences.edit().putString("invalidSource", config.identity).apply();
        state = new State("changed", CHANGED, true);
        return new IOException(CHANGED);
    }

    private static String value(String value) { return value == null ? "" : value.trim(); }

    static final class Configuration {
        final byte[] json;
        final String url;
        final long bytes;
        final String etag;
        final String identity;
        final Map<Long, Integer> positions;

        Configuration(byte[] json, String url, long bytes, String etag, Map<Long, Integer> positions) {
            this.json = json;
            this.url = url;
            this.bytes = bytes;
            this.etag = etag;
            this.positions = positions;
            identity = url + "/" + etag + "/" + bytes;
        }
    }

    static final class Preview {
        final byte[] bytes;
        final String type;

        Preview(byte[] bytes) throws IOException {
            this.bytes = bytes;
            type = NaxLibrary.imageType(bytes);
            if (type == null) throw new IOException("Invalid cached image");
        }
    }

    private static final class State {
        final String status;
        final String message;
        final boolean checked;

        State(String status, String message, boolean checked) {
            this.status = status;
            this.message = message;
            this.checked = checked;
        }
    }
}
