package app.nai.pocketlibrary;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import android.util.JsonReader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Device-only gallery. New imports keep a small preview plus the source URI; legacy rows keep
 * their complete private copy. The source document is never modified or deleted.
 */
final class GalleryStore {
    private static final int PAGE_SIZE = 24;
    private static final int MAX_PREVIEW_BYTES = 192 * 1024;
    private static final int MAX_PREVIEW_EDGE = 640;
    private static final int MAX_PROMPT_BYTES = 16 * 1024 * 1024;
    private static final long MAX_PIXELS = 24_000_000L;
    private static final String PREVIEW_MIME = "image/jpeg";
    private static GalleryStore shared;
    private final File directory;
    private final AtomicFile index;
    private final ContentResolver resolver;
    private Map<String, JSONObject> records;
    private List<Map.Entry<String, JSONObject>> listed;
    private long listedBytes;

    static synchronized GalleryStore get(Context context) {
        if (shared == null) shared = new GalleryStore(context.getApplicationContext());
        return shared;
    }

    private GalleryStore(Context context) {
        directory = new File(context.getFilesDir(), "gallery-originals");
        index = new AtomicFile(new File(directory, "index.json"));
        resolver = context.getContentResolver();
    }

    synchronized JSONObject list(int requestedPage) throws IOException, JSONException {
        if (listed == null) {
            listed = new ArrayList<>(records().entrySet());
            listed.sort(Comparator.comparingLong((Map.Entry<String, JSONObject> item) -> item.getValue().optLong("createdAt"))
                    .thenComparing(Map.Entry::getKey).reversed());
            listedBytes = 0;
            for (Map.Entry<String, JSONObject> item : listed) listedBytes += storageBytes(item.getKey());
        }
        int total = listed.size();
        int pages = total == 0 ? 0 : (total - 1) / PAGE_SIZE + 1;
        int page = Math.max(0, Math.min(requestedPage, pages - 1));
        int start = page * PAGE_SIZE;
        JSONArray items = new JSONArray();
        for (int i = start; i < Math.min((long) start + PAGE_SIZE, total); i++) {
            Map.Entry<String, JSONObject> item = listed.get(i);
            items.put(publicRow(item.getKey(), item.getValue()));
        }
        return new JSONObject().put("items", items).put("total", total).put("bytes", listedBytes)
                .put("page", page).put("pages", pages);
    }

    synchronized Entry entry(String id) throws IOException, JSONException {
        if (!validId(id)) throw new IOException("无效的图库条目。");
        JSONObject row = records().get(id);
        if (row == null) throw new IOException("图库中找不到这个条目。");
        File original = imageFile(id);
        File preview = previewFile(id);
        if (original.isFile()) {
            return new Entry(id, row, null, original, row.optString("mime", "image/jpeg"));
        }
        if (preview.isFile()) {
            return new Entry(id, row, preview, null, row.optString("sourceMime", "image/jpeg"));
        }
        throw new IOException("图库预览文件已丢失。");
    }

    synchronized JSONObject save(Uri uri) throws IOException, JSONException {
        if (uri == null || !"content".equals(uri.getScheme())) throw new IOException("请从手机文件中选择原图。");
        Map<String, JSONObject> current = records();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建图库。");
        if (directory.getUsableSpace() < 8L * 1024 * 1024) throw new IOException("手机剩余空间不足。");

        MessageDigest digest = digest();
        long sourceBytes = 0;
        byte[] header = new byte[32];
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) throw new IOException("无法打开所选图片。");
            byte[] buffer = new byte[32768];
            for (int read; (read = input.read(buffer)) >= 0;) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("导入已取消。");
                if (read == 0) continue;
                if (read > ImagePrompts.MAX_INPUT - sourceBytes) throw new IOException("单张原图最多支持 32 MB。");
                if (sourceBytes < header.length) {
                    System.arraycopy(buffer, 0, header, (int)sourceBytes,
                            Math.min(read, header.length - (int)sourceBytes));
                }
                digest.update(buffer, 0, read);
                sourceBytes += read;
            }
        } catch (SecurityException failure) {
            throw new IOException("没有读取所选原图的权限，请重新选择。");
        }

        String sourceMime = NaxLibrary.imageType(header);
        if (!("image/png".equals(sourceMime) || "image/jpeg".equals(sourceMime) || "image/webp".equals(sourceMime))) {
            throw new IOException("图库支持 PNG、JPEG 或 WebP 原图。");
        }
        String id = hex(digest.digest());
        JSONObject existing = current.get(id);
        if (existing != null && entryFile(id, existing) != null) {
            if (!imageFile(id).isFile()) {
                // Re-selecting the same bytes can reconnect a moved source without making a new preview.
                linkSource(current, id, new JSONObject(existing.toString()), uri);
            }
            return new JSONObject().put("id", id).put("added", false);
        }

        byte[] preview = createPreview(() -> resolver.openInputStream(uri));

        JSONObject metadata = new JSONObject()
                .put("id", id)
                .put("name", displayName(uri))
                .put("kind", "preview")
                .put("format", formatName(sourceMime))
                .put("sourceMime", sourceMime)
                .put("previewType", PREVIEW_MIME)
                .put("previewBytes", preview.length)
                .put("originalBytes", sourceBytes)
                .put("createdAt", System.currentTimeMillis());
        File previewFile = previewFile(id);
        File temporary = File.createTempFile("preview-", ".part", directory);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(preview);
                output.getFD().sync();
            }
            Files.move(temporary.toPath(), previewFile.toPath(), StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
            try {
                linkSource(current, id, metadata, uri);
            } catch (IOException | JSONException failure) {
                previewFile.delete();
                throw failure;
            }
            return new JSONObject().put("id", id).put("added", true);
        } finally {
            if (temporary.exists()) temporary.delete();
        }
    }

    synchronized JSONObject savePacked(File original, String requestedName, JSONObject sourceInfo,
                                       JSONObject summary) throws IOException, JSONException {
        if (original == null || !original.isFile()) throw new IOException("在线图包原图无法加载。");
        if (original.length() < 1 || original.length() > ImagePrompts.MAX_INPUT) {
            throw new IOException("在线图包原图大小异常，未保存到图库。");
        }
        Map<String, JSONObject> current = records();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建图库。");
        if (directory.getUsableSpace() < 8L * 1024 * 1024) throw new IOException("手机剩余空间不足。");

        MessageDigest digest = digest();
        long sourceBytes = 0;
        byte[] header = new byte[32];
        try (InputStream input = new FileInputStream(original)) {
            byte[] buffer = new byte[32768];
            for (int read; (read = input.read(buffer)) >= 0;) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("保存已取消。");
                if (read == 0) continue;
                if (read > ImagePrompts.MAX_INPUT - sourceBytes) throw new IOException("在线图包原图超过 32 MB。");
                if (sourceBytes < header.length) {
                    System.arraycopy(buffer, 0, header, (int)sourceBytes,
                            Math.min(read, header.length - (int)sourceBytes));
                }
                digest.update(buffer, 0, read);
                sourceBytes += read;
            }
        }
        String sourceMime = NaxLibrary.imageType(header);
        if (!("image/png".equals(sourceMime) || "image/jpeg".equals(sourceMime) || "image/webp".equals(sourceMime))) {
            throw new IOException("在线图包图片不是支持的 PNG、JPEG 或 WebP。");
        }

        String id = hex(digest.digest());
        JSONObject existing = current.get(id);
        if (existing != null && entryFile(id, existing) != null) {
            boolean promptCached = false;
            if (summary != null) {
                try {
                    promptCached = savePrompt(id, summary);
                } catch (Exception ignored) {
                    // The existing permanent preview remains usable when its text cache fills up.
                }
            }
            return new JSONObject().put("id", id).put("added", false).put("promptCached", promptCached);
        }

        byte[] preview = createPreview(() -> new FileInputStream(original));

        String name = cleanText(requestedName, "在线图包图片", 120);
        JSONObject source = sourceInfo == null ? new JSONObject() : sourceInfo;
        JSONObject row = new JSONObject()
                .put("id", id)
                .put("name", name)
                .put("kind", "preview")
                .put("format", formatName(sourceMime))
                .put("sourceMime", sourceMime)
                .put("previewType", PREVIEW_MIME)
                .put("previewBytes", preview.length)
                .put("originalBytes", sourceBytes)
                .put("createdAt", System.currentTimeMillis())
                .put("sourceType", "online-pack")
                .put("sourceTitle", cleanText(source.optString("title"), "", 120))
                .put("sourcePage", cleanText(source.optString("source"), "", 300))
                .put("sourceRevision", cleanText(source.optString("revision"), "", 128))
                .put("sourceImageId", cleanText(source.optString("imageId"), id, 128));
        File previewFile = previewFile(id);
        File temporary = File.createTempFile("preview-", ".part", directory);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(preview);
                output.getFD().sync();
            }
            Files.move(temporary.toPath(), previewFile.toPath(), StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
            try {
                putRow(current, id, row);
            } catch (IOException | JSONException failure) {
                previewFile.delete();
                throw failure;
            }
        } finally {
            if (temporary.exists()) temporary.delete();
        }

        boolean promptCached = false;
        if (summary != null) {
            try {
                promptCached = savePrompt(id, summary);
            } catch (Exception ignored) {
                // Keep the permanent preview and report that the text cache was not saved.
            }
        }
        return new JSONObject().put("id", id).put("added", true).put("promptCached", promptCached);
    }

    synchronized JSONObject cachedPrompt(String id) throws IOException, JSONException {
        if (!validId(id)) throw new IOException("无效的图库条目。");
        JSONObject row = records().get(id);
        if (row == null) throw new IOException("图库中找不到这个条目。");
        File file = promptFile(id);
        if (!file.isFile()) return null;
        if (file.length() > MAX_PROMPT_BYTES) throw new IOException("图库中的提示词缓存异常。");
        try (FileInputStream input = new FileInputStream(file)) {
            JSONObject summary = new JSONObject(new String(NaxLibrary.readBounded(input, MAX_PROMPT_BYTES),
                    StandardCharsets.UTF_8));
            summary.put("promptCached", true);
            return summary;
        } catch (JSONException corrupt) {
            Files.deleteIfExists(file.toPath());
            listed = null;
            return null;
        }
    }

    synchronized boolean savePrompt(String id, JSONObject source) throws IOException, JSONException {
        if (!validId(id)) throw new IOException("无效的图库条目。");
        Map<String, JSONObject> current = records();
        if (!current.containsKey(id)) throw new IOException("图库中找不到这个条目。");
        File promptFile = promptFile(id);
        if (promptFile.isFile()) return true;

        JSONObject exact = new JSONObject();
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!"preview".equals(key)) exact.put(key, source.get(key));
        }
        byte[] bytes = exact.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > MAX_PROMPT_BYTES) return false;
        if (bytes.length > directory.getUsableSpace()) return false;

        File temporary = File.createTempFile("prompt-", ".part", directory);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.getFD().sync();
            }
            Files.move(temporary.toPath(), promptFile.toPath(), StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
            listed = null;
            return true;
        } finally {
            if (temporary.exists()) temporary.delete();
        }
    }

    synchronized boolean delete(String id) throws IOException, JSONException {
        if (!validId(id)) throw new IOException("无效的图库条目。");
        Map<String, JSONObject> current = records();
        JSONObject removed = current.get(id);
        if (removed == null) return false;
        Files.deleteIfExists(promptFile(id).toPath());
        Files.deleteIfExists(previewFile(id).toPath());
        Files.deleteIfExists(imageFile(id).toPath());
        current.remove(id);
        listed = null;
        try {
            writeIndex(current);
        } catch (IOException ignored) {
            // The files are gone. Opening the index ignores records without a gallery image.
        }
        releaseUnusedSource(removed, current);
        return true;
    }

    byte[] preview(Entry entry) throws IOException {
        if (entry.previewFile != null && entry.previewFile.isFile()) {
            if (entry.previewFile.length() > MAX_PREVIEW_BYTES) throw new IOException("图库预览文件异常。");
            return Files.readAllBytes(entry.previewFile.toPath());
        }
        if (entry.originalFile != null && entry.originalFile.isFile()) {
            return createPreview(() -> new FileInputStream(entry.originalFile));
        }
        throw new IOException("图库预览文件已丢失。");
    }

    byte[] previewPacked(File original) throws IOException {
        return createPreview(() -> new FileInputStream(original));
    }

    InputStream original(Entry entry) throws IOException {
        if (entry.originalFile != null && entry.originalFile.isFile()) return new FileInputStream(entry.originalFile);
        if (entry.sourceUri != null) {
            try {
                InputStream input = resolver.openInputStream(entry.sourceUri);
                if (input == null) throw new FileNotFoundException("无法打开手机原图。");
                return input;
            } catch (SecurityException failure) {
                throw new IOException("手机原图读取权限已失效。");
            }
        }
        throw new IOException("手机原图已移动或不再可读取。");
    }

    private byte[] createPreview(ImageSource source) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream input = source.open()) {
            if (input == null) throw new IOException("无法重新打开所选图片。");
            BitmapFactory.decodeStream(input, null, bounds);
        } catch (SecurityException failure) {
            throw new IOException("没有读取所选原图的权限，请重新选择。");
        }
        if (bounds.outWidth < 1 || bounds.outHeight < 1) throw new IOException("图片损坏，无法生成预览。");
        if ((long)bounds.outWidth * bounds.outHeight > MAX_PIXELS) {
            throw new IOException("图片超过图库的 2400 万像素上限。");
        }

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > MAX_PREVIEW_EDGE) {
            options.inSampleSize *= 2;
        }
        options.inScaled = false;
        Bitmap bitmap = null;
        try (InputStream input = source.open()) {
            if (input == null) throw new IOException("无法重新打开所选图片。");
            bitmap = BitmapFactory.decodeStream(input, null, options);
        } catch (SecurityException failure) {
            throw new IOException("没有读取所选原图的权限，请重新选择。");
        } catch (OutOfMemoryError tooLarge) {
            throw new IOException("手机内存不足，无法生成图库预览。");
        }
        if (bitmap == null) throw new IOException("图片损坏，无法生成预览。");
        try {
            int longest = Math.max(bitmap.getWidth(), bitmap.getHeight());
            int[] targets = { MAX_PREVIEW_EDGE, 560, 480 };
            for (int target : targets) {
                if (target > longest && target != targets[0]) continue;
                int width = bitmap.getWidth();
                int height = bitmap.getHeight();
                if (target < longest) {
                    double scale = target / (double)longest;
                    width = Math.max(1, (int)Math.round(bitmap.getWidth() * scale));
                    height = Math.max(1, (int)Math.round(bitmap.getHeight() * scale));
                }
                Bitmap scaled = width == bitmap.getWidth() && height == bitmap.getHeight()
                        ? bitmap : Bitmap.createScaledBitmap(bitmap, width, height, true);
                try {
                    for (int quality : new int[] { 82, 70, 58 }) {
                        ByteArrayOutputStream output = new ByteArrayOutputStream();
                        if (!scaled.compress(Bitmap.CompressFormat.JPEG, quality, output)) continue;
                        if (output.size() <= MAX_PREVIEW_BYTES) return output.toByteArray();
                    }
                } finally {
                    if (scaled != bitmap) scaled.recycle();
                }
            }
            throw new IOException("无法把这张图片压缩到图库预览上限内。");
        } finally {
            bitmap.recycle();
        }
    }

    private Map<String, JSONObject> records() throws IOException, JSONException {
        if (records != null) return records;
        Map<String, JSONObject> loaded = new LinkedHashMap<>();
        try (JsonReader input = new JsonReader(new InputStreamReader(index.openRead(), StandardCharsets.UTF_8))) {
            input.beginArray();
            while (input.hasNext()) {
                JSONObject row = readIndexRow(input);
                String id = row.optString("id", "");
                if (validId(id) && entryFile(id, row) != null) loaded.put(id, row);
            }
            input.endArray();
        } catch (FileNotFoundException absent) {
            if (index.getBaseFile().exists()) throw absent;
        }
        cleanupLeftovers(loaded);
        records = loaded;
        return loaded;
    }

    private static JSONObject readIndexRow(JsonReader input) throws IOException, JSONException {
        JSONObject row = new JSONObject();
        input.beginObject();
        while (input.hasNext()) {
            String name = input.nextName();
            switch (input.peek()) {
                case BOOLEAN: row.put(name, input.nextBoolean()); break;
                case NUMBER: row.put(name, input.nextLong()); break;
                case STRING: row.put(name, input.nextString()); break;
                default: input.skipValue();
            }
        }
        input.endObject();
        return row;
    }

    private void cleanupLeftovers(Map<String, JSONObject> loaded) {
        if (!directory.isDirectory()) return;
        File[] leftovers = directory.listFiles((folder, name) ->
                name.matches("(?:import|preview|prompt)-[0-9]+\\.part")
                        || name.matches("[a-f0-9]{64}\\.(?:image|preview|prompt)"));
        if (leftovers == null) return;
        for (File leftover : leftovers) {
            String name = leftover.getName();
            int dot = name.indexOf('.');
            String id = dot < 0 ? "" : name.substring(0, dot);
            if (name.endsWith(".prompt")) {
                if (!loaded.containsKey(id)) leftover.delete();
                continue;
            }
            File expected = loaded.containsKey(id) ? entryFile(id, loaded.get(id)) : null;
            if (expected == null || !expected.equals(leftover)) leftover.delete();
        }
    }

    private void writeIndex(Map<String, JSONObject> next) throws IOException {
        FileOutputStream output = index.startWrite();
        try {
            OutputStreamWriter writer = new OutputStreamWriter(output, StandardCharsets.UTF_8);
            writer.write('[');
            boolean first = true;
            for (JSONObject row : next.values()) {
                if (!first) writer.write(',');
                writer.write(row.toString());
                first = false;
            }
            writer.write(']');
            writer.flush();
            index.finishWrite(output);
        } catch (IOException failure) {
            index.failWrite(output);
            throw failure;
        }
    }

    private void putRow(Map<String, JSONObject> current, String id, JSONObject row)
            throws IOException, JSONException {
        Map<String, JSONObject> next = new LinkedHashMap<>(current);
        JSONObject previous = next.put(id, row);
        try {
            writeIndex(next);
        } catch (IOException failure) {
            releaseUnusedSource(row, current);
            throw failure;
        }
        records = next;
        listed = null;
        releaseUnusedSource(previous, next);
    }

    private static String cleanText(String value, String fallback, int limit) {
        String text = value == null ? "" : value.replaceAll("[\\p{Cntrl}]", " ").trim();
        if (text.isEmpty()) text = fallback;
        return text.substring(0, Math.min(text.length(), limit));
    }

    private JSONObject publicRow(String id, JSONObject row) throws JSONException {
        String kind = imageFile(id).isFile() ? "copy" : "preview";
        return new JSONObject()
                .put("id", id)
                .put("name", row.optString("name", kind.equals("copy") ? "旧版原图副本" : "导入的图片"))
                .put("format", row.optString("format", "图片"))
                .put("createdAt", row.optLong("createdAt"))
                .put("kind", kind)
                .put("bytes", storageBytes(id))
                .put("hasPrompt", promptFile(id).isFile())
                .put("sourceLinked", kind.equals("preview") && row.optString("sourceUri", "").startsWith("content://"));
    }

    private long storageBytes(String id) {
        String kind = imageFile(id).isFile() ? "image" : "preview";
        File entry = new File(directory, id + "." + kind);
        return (entry.isFile() ? entry.length() : 0) + promptFile(id).length();
    }

    private File entryFile(String id, JSONObject row) {
        File original = imageFile(id);
        if (original.isFile()) return original;
        File preview = previewFile(id);
        return preview.isFile() ? preview : null;
    }

    private File imageFile(String id) { return new File(directory, id + ".image"); }
    private File previewFile(String id) { return new File(directory, id + ".preview"); }
    private File promptFile(String id) { return new File(directory, id + ".prompt"); }

    private void linkSource(Map<String, JSONObject> current, String id, JSONObject row, Uri uri)
            throws IOException, JSONException {
        String source = uri.toString();
        row.put("sourceUri", source);
        row.put("galleryGrant", retainSource(uri, current));
        Map<String, JSONObject> next = new LinkedHashMap<>(current);
        JSONObject previous = next.put(id, row);
        try {
            writeIndex(next);
        } catch (IOException failure) {
            releaseUnusedSource(row, current);
            throw failure;
        }
        records = next;
        listed = null;
        releaseUnusedSource(previous, next);
    }

    private boolean retainSource(Uri uri, Map<String, JSONObject> current) {
        try {
            boolean alreadyGranted = resolver.getPersistedUriPermissions().stream()
                    .anyMatch(grant -> grant.isReadPermission() && uri.equals(grant.getUri()));
            if (alreadyGranted) {
                return current.values().stream().anyMatch(row -> row.optBoolean("galleryGrant")
                        && uri.toString().equals(row.optString("sourceUri")));
            }
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (RuntimeException denied) {
            return false;
        }
    }

    private void releaseUnusedSource(JSONObject row, Map<String, JSONObject> current) {
        if (row == null || !row.optBoolean("galleryGrant")) return;
        String source = row.optString("sourceUri");
        if (!source.startsWith("content://")) return;
        if (current.values().stream().anyMatch(other -> source.equals(other.optString("sourceUri")))) return;
        try {
            resolver.releasePersistableUriPermission(Uri.parse(source), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (RuntimeException ignored) {
            // The source grant may already have been revoked by the system.
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String raw = cursor.getString(0);
                if (raw != null) {
                    String name = raw.replaceAll("[\\p{Cntrl}/\\\\]", " ").trim();
                    if (!name.isEmpty()) return name.substring(0, Math.min(name.length(), 120));
                }
            }
        } catch (RuntimeException ignored) {
            // Names are optional.
        }
        return "导入的图片";
    }

    private static String formatName(String mime) {
        if ("image/png".equals(mime)) return "PNG";
        if ("image/webp".equals(mime)) return "WebP";
        return "JPEG";
    }

    private static boolean validId(String id) {
        return id != null && id.matches("[a-f0-9]{64}");
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            value.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        }
        return value.toString();
    }

    private interface ImageSource {
        InputStream open() throws IOException;
    }

    static final class Entry {
        final String id;
        final Uri sourceUri;
        final File previewFile;
        final File originalFile;
        final String originalMime;
        final String name;
        final String format;
        final long createdAt;
        final String sourceTitle;
        final String sourcePage;

        Entry(String id, JSONObject row, File previewFile, File originalFile, String originalMime) {
            this.id = id;
            this.previewFile = previewFile;
            this.originalFile = originalFile;
            this.originalMime = originalMime == null || originalMime.isEmpty() ? "image/jpeg" : originalMime;
            String raw = row.optString("sourceUri", "");
            this.sourceUri = raw.startsWith("content://") ? Uri.parse(raw) : null;
            this.name = row.optString("name", "导入的图片");
            this.format = row.optString("format", "图片");
            this.createdAt = row.optLong("createdAt");
            this.sourceTitle = row.optString("sourceTitle");
            this.sourcePage = row.optString("sourcePage");
        }
    }
}
