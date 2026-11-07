package app.nai.pocketlibrary;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.AtomicFile;
import android.util.Base64;
import android.util.JsonReader;
import android.util.JsonToken;
import android.util.JsonWriter;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class NaxLibrary {
    static final Set<String> GALLERIES = new HashSet<>(Arrays.asList(
            "danbooru-artist-tags-2-v5", "danbooru-artist-tags-v5", "danbooru-artist-tags-male-2-v5",
            "danbooru-artist-tags-2-v4.5", "danbooru-artist-tags-v4.5", "artists-v4.5",
            "danbooru-character-tags-v5", "danbooru-character-tags-v4.5",
            "danbooru-hair-tags-v5", "danbooru-hair-tags-v4.5", "danbooru-face-tags-v4.5"));
    private static final int MAX_PREVIEW = 6 * 1024 * 1024;
    private static final long CACHE_BUDGET = 32L * 1024 * 1024;
    private final File index;
    private final File previews;
    private final SharedPreferences version;

    NaxLibrary(Context context) {
        // v1 did not contain the knowledge galleries; it cannot be reused after a 304 response.
        index = new File(context.getFilesDir(), "nax-index-v2.json");
        previews = new File(context.getCacheDir(), "nax-previews");
        version = context.getSharedPreferences("nax-version", Context.MODE_PRIVATE);
    }

    boolean hasIndex() {
        return index.isFile();
    }

    synchronized Catalog openIndex(boolean check) throws IOException {
        String status = "cached";
        if (check || !hasIndex()) {
            boolean existing = hasIndex();
            boolean matchedVersion = existing && version.getLong("stamp", -1) == index.lastModified();
            String etag = matchedVersion ? version.getString("etag", "") : "";
            String modified = matchedVersion ? version.getString("modified", "") : "";
            Download result = fetch(new URL("https://nax.moe/downloads/tags.zip"), 3 * 1024 * 1024, etag, modified);
            if (result.bytes == null && existing) {
                status = "current";
            } else if (result.bytes == null) {
                throw new IOException("Catalog missing");
            } else {
                String fingerprint = digest(result.bytes);
                boolean changed = !matchedVersion || !fingerprint.equals(version.getString("fingerprint", ""));
                if (changed) cacheIndex(result.bytes, new AtomicFile(index));
                version.edit().putLong("stamp", index.lastModified()).putString("fingerprint", fingerprint)
                        .putString("etag", result.etag).putString("modified", result.modified).apply();
                status = !existing ? "downloaded" : changed ? "updated" : "current";
            }
        }
        return new Catalog(new AtomicFile(index).openRead(), status, Long.toString(index.lastModified()));
    }

    static final class Catalog {
        final InputStream data;
        final String status;
        final String revision;

        Catalog(InputStream data, String status, String revision) {
            this.data = data;
            this.status = status;
            this.revision = revision;
        }
    }

    private static String digest(byte[] bytes) throws IOException {
        try {
            return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes), Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IOException(impossible);
        }
    }

    static void cacheIndex(byte[] archive, AtomicFile target) throws IOException {
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archive))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (!"tags.json".equals(entry.getName())) continue;
                byte[] json = readBounded(zip, 20 * 1024 * 1024);
                FileOutputStream output = target.startWrite();
                try {
                    JsonReader reader = new JsonReader(new InputStreamReader(new ByteArrayInputStream(json), StandardCharsets.UTF_8));
                    JsonWriter writer = new JsonWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8));
                    if (filterCatalog(reader, writer) == 0) throw new IOException("Empty catalog");
                    writer.flush();
                    target.finishWrite(output);
                } catch (Exception failure) {
                    target.failWrite(output);
                    throw new IOException("Invalid NAX catalog", failure);
                }
                return;
            }
        }
        throw new IOException("Catalog entry missing");
    }

    private static int filterCatalog(JsonReader reader, JsonWriter writer) throws IOException {
        int count = 0;
        writer.beginObject();
        reader.beginObject();
        while (reader.hasNext()) {
            if (!"galleries".equals(reader.nextName())) {
                reader.skipValue();
                continue;
            }
            reader.beginObject();
            while (reader.hasNext()) {
                String gallery = reader.nextName();
                if (!GALLERIES.contains(gallery)) {
                    reader.skipValue();
                    continue;
                }
                writer.name(gallery).beginArray();
                reader.beginObject();
                while (reader.hasNext()) {
                    if (!"tags".equals(reader.nextName())) {
                        reader.skipValue();
                        continue;
                    }
                    reader.beginArray();
                    while (reader.hasNext()) {
                        String tag = "", filename = "";
                        reader.beginObject();
                        while (reader.hasNext()) {
                            String key = reader.nextName();
                            if ("tag".equals(key) && reader.peek() == JsonToken.STRING) tag = reader.nextString();
                            else if ("filename".equals(key) && reader.peek() == JsonToken.STRING) filename = reader.nextString();
                            else reader.skipValue();
                        }
                        reader.endObject();
                        if (!tag.isEmpty() && tag.length() <= 400 && validFilename(filename)) {
                            writer.beginArray().value(tag).value(filename).endArray();
                            count++;
                        }
                    }
                    reader.endArray();
                }
                reader.endObject();
                writer.endArray();
            }
            reader.endObject();
        }
        reader.endObject();
        writer.endObject();
        return count;
    }

    InputStream openPreview(String gallery, String filename) throws IOException {
        if (!GALLERIES.contains(gallery) || !validFilename(filename)) throw new IOException("Invalid image path");
        String id = UUID.nameUUIDFromBytes((index.lastModified() + "/" + gallery + "/" + filename).getBytes(StandardCharsets.UTF_8)).toString();
        File file = new File(previews, id + ".webp");
        if (file.isFile()) {
            file.setLastModified(System.currentTimeMillis());
            return new FileInputStream(file);
        }
        Uri url = new Uri.Builder().scheme("https").authority("cdn.zele.st")
                .appendPath("data").appendPath("NAX").appendPath("Images").appendPath(gallery).appendPath(filename).build();
        byte[] bytes = fetch(new URL(url.toString()), MAX_PREVIEW, "", "").bytes;
        if (!"image/webp".equals(imageType(bytes))) throw new IOException("Invalid image");
        try {
            writePreview(file, bytes);
        } catch (IOException ignored) {
            // A full cache should not prevent displaying a fetched image.
        }
        return new ByteArrayInputStream(bytes);
    }

    private synchronized void writePreview(File file, byte[] bytes) throws IOException {
        if (file.isFile()) return;
        if (!previews.isDirectory() && !previews.mkdirs()) return;
        AtomicFile cache = new AtomicFile(file);
        FileOutputStream output = cache.startWrite();
        try {
            output.write(bytes);
            cache.finishWrite(output);
        } catch (IOException failure) {
            cache.failWrite(output);
            throw failure;
        }
        File[] entries = previews.listFiles(path -> path.getName().endsWith(".webp"));
        if (entries == null) return;
        long size = 0;
        for (File item : entries) size += item.length();
        if (size <= CACHE_BUDGET) return;
        Arrays.sort(entries, Comparator.comparingLong(File::lastModified));
        for (File item : entries) {
            if (size <= CACHE_BUDGET) break;
            long length = item.length();
            if (!item.equals(file) && item.delete()) size -= length;
        }
    }

    private static boolean validFilename(String filename) {
        if (filename.length() < 6 || filename.length() > 512 || !filename.endsWith(".webp")) return false;
        for (int i = 0; i < filename.length(); i++) {
            char ch = filename.charAt(i);
            if (ch == '/' || ch == '\\' || Character.isISOControl(ch)) return false;
        }
        return true;
    }

    private static final class Download {
        final byte[] bytes;
        final String etag;
        final String modified;

        Download(byte[] bytes, String etag, String modified) {
            this.bytes = bytes;
            this.etag = etag;
            this.modified = modified;
        }
    }

    private static Download fetch(URL url, int limit, String etag, String modified) throws IOException {
        for (int redirects = 0; redirects < 4; redirects++) {
            if (!"https".equals(url.getProtocol()) ||
                    !("nax.moe".equals(url.getHost()) || "www.nax.moe".equals(url.getHost()) || "cdn.zele.st".equals(url.getHost()))) {
                throw new IOException("Unexpected download host");
            }
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(15000);
            if (etag != null && !etag.isEmpty()) connection.setRequestProperty("If-None-Match", etag);
            if (modified != null && !modified.isEmpty()) connection.setRequestProperty("If-Modified-Since", modified);
            try {
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("Missing redirect");
                    url = new URL(url, location);
                    continue;
                }
                if (status == 304 && ((etag != null && !etag.isEmpty()) || (modified != null && !modified.isEmpty()))) {
                    return new Download(null, etag, modified);
                }
                if (status != 200 || connection.getContentLengthLong() > limit) throw new IOException("Download unavailable");
                try (InputStream input = connection.getInputStream()) {
                    return new Download(readBounded(input, limit), connection.getHeaderField("ETag"),
                            connection.getHeaderField("Last-Modified"));
                }
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many redirects");
    }

    static byte[] readBounded(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[32768];
        int count;
        while ((count = input.read(buffer)) >= 0) {
            if (count > limit - output.size()) throw new IOException("Resource too large");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    static String imageType(byte[] bytes) {
        if (bytes.length < 12) return null;
        if ((bytes[0] & 255) == 255 && (bytes[1] & 255) == 216 && (bytes[2] & 255) == 255) return "image/jpeg";
        if ((bytes[0] & 255) == 137 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G') return "image/png";
        if (bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F' &&
                bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') return "image/webp";
        if (bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F') return "image/gif";
        return null;
    }
}
