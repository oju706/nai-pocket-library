package app.nai.pocketlibrary;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.AtomicFile;

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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Device-only gallery. Original bytes are copied unchanged and keyed by SHA-256. */
final class GalleryStore {
    private static final long MAX_BYTES = 1024L * 1024 * 1024;
    private static final int MAX_ENTRIES = 2000;
    private static final int MAX_INDEX = 2 * 1024 * 1024;
    private static GalleryStore shared;
    private final File directory;
    private final AtomicFile index;
    private final ContentResolver resolver;
    private Map<String, JSONObject> records;

    static synchronized GalleryStore get(Context context) {
        if (shared == null) shared = new GalleryStore(context.getApplicationContext());
        return shared;
    }

    private GalleryStore(Context context) {
        directory = new File(context.getFilesDir(), "gallery-originals");
        index = new AtomicFile(new File(directory, "index.json"));
        resolver = context.getContentResolver();
    }

    synchronized JSONArray list() throws IOException, JSONException {
        List<JSONObject> result = new ArrayList<>();
        for (Map.Entry<String, JSONObject> row : records().entrySet()) {
            if (file(row.getKey()).isFile()) result.add(row.getValue());
        }
        result.sort(Comparator.comparingLong((JSONObject entry) -> entry.optLong("createdAt")).reversed());
        return new JSONArray(result);
    }

    synchronized Entry entry(String id) throws IOException, JSONException {
        if (!validId(id)) throw new IOException("无效的图库条目。");
        JSONObject metadata = records().get(id);
        File original = file(id);
        if (metadata == null || !original.isFile()) throw new IOException("图库中找不到这张原图。");
        return new Entry(original, metadata.getString("mime"));
    }

    synchronized JSONObject save(Uri uri) throws IOException, JSONException {
        if (uri == null || !"content".equals(uri.getScheme())) throw new IOException("请从手机文件中选择原图。");
        Map<String, JSONObject> current = records();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建图库。");
        if (directory.getUsableSpace() < 8L * 1024 * 1024) throw new IOException("手机剩余空间不足。");
        File temporary = File.createTempFile("import-", ".part", directory);
        try {
            MessageDigest digest = digest();
            long bytes = 0;
            byte[] header = new byte[12];
            try (InputStream input = resolver.openInputStream(uri); FileOutputStream output = new FileOutputStream(temporary)) {
                if (input == null) throw new IOException("无法打开所选图片。");
                byte[] buffer = new byte[32768];
                for (int read; (read = input.read(buffer)) >= 0;) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("导入已取消。");
                    if (read > ImagePrompts.MAX_INPUT - bytes) throw new IOException("单张原图最多支持 32 MB。");
                    if (bytes < header.length) System.arraycopy(buffer, 0, header, (int) bytes, Math.min(read, header.length - (int) bytes));
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                    bytes += read;
                }
                output.getFD().sync();
            }
            String mime = NaxLibrary.imageType(header);
            if (bytes < header.length || !("image/png".equals(mime) || "image/jpeg".equals(mime) || "image/webp".equals(mime))) {
                throw new IOException("图库支持 PNG、JPEG 或 WebP 原图。");
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(temporary.getAbsolutePath(), bounds);
            if (bounds.outWidth < 1 || bounds.outHeight < 1 || (long) bounds.outWidth * bounds.outHeight > 24_000_000L) {
                throw new IOException("图片损坏或超过图库的 2400 万像素上限。");
            }
            String id = hex(digest.digest());
            if (current.containsKey(id) && file(id).isFile()) return new JSONObject().put("id", id).put("added", false);
            long stored = 0;
            for (String existing : current.keySet()) stored += file(existing).length();
            if (current.size() >= MAX_ENTRIES || bytes > MAX_BYTES - stored) throw new IOException("图库空间已满（1 GB 或 2,000 张）。");
            JSONObject metadata = new JSONObject().put("id", id).put("name", displayName(uri)).put("mime", mime)
                    .put("format", "image/png".equals(mime) ? "PNG" : "image/webp".equals(mime) ? "WebP" : "JPEG")
                    .put("bytes", bytes).put("createdAt", System.currentTimeMillis());
            File original = file(id);
            Files.move(temporary.toPath(), original.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            Map<String, JSONObject> next = new LinkedHashMap<>(current);
            next.put(id, metadata);
            try { writeIndex(next); }
            catch (IOException failure) { original.delete(); throw failure; }
            records = next;
            return new JSONObject().put("id", id).put("added", true);
        } finally { if (temporary.exists()) temporary.delete(); }
    }

    byte[] thumbnail(Entry entry) throws IOException {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(entry.file.getAbsolutePath(), options);
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("无法读取缩略图。");
        options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 480) options.inSampleSize *= 2;
        options.inJustDecodeBounds = false;
        Bitmap bitmap = BitmapFactory.decodeFile(entry.file.getAbsolutePath(), options);
        if (bitmap == null) throw new IOException("无法读取缩略图。");
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 78, output)) throw new IOException("无法生成缩略图。");
            return output.toByteArray();
        } finally { bitmap.recycle(); }
    }

    private Map<String, JSONObject> records() throws IOException, JSONException {
        if (records != null) return records;
        Map<String, JSONObject> loaded = new LinkedHashMap<>();
        try (FileInputStream input = index.openRead()) {
            JSONArray rows = new JSONArray(new String(NaxLibrary.readBounded(input, MAX_INDEX), StandardCharsets.UTF_8));
            if (rows.length() > MAX_ENTRIES) throw new IOException("图库目录大小异常。");
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                String id = row.getString("id");
                if (validId(id) && file(id).isFile()) loaded.put(id, row);
            }
        } catch (FileNotFoundException absent) {
            if (index.getBaseFile().exists()) throw absent;
        }
        File[] leftovers = directory.listFiles((folder, name) -> name.matches("import-[0-9]+\\.part")
                || (name.matches("[a-f0-9]{64}\\.image") && !loaded.containsKey(name.substring(0, 64))));
        if (leftovers != null) for (File leftover : leftovers) leftover.delete();
        records = loaded;
        return loaded;
    }

    private void writeIndex(Map<String, JSONObject> next) throws IOException {
        byte[] bytes = new JSONArray(next.values()).toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_INDEX) throw new IOException("图库目录超过上限。");
        FileOutputStream output = index.startWrite();
        try { output.write(bytes); index.finishWrite(output); }
        catch (IOException failure) { index.failWrite(output); throw failure; }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String raw = cursor.getString(0);
                if (raw != null) {
                    String name = raw.replaceAll("[\\p{Cntrl}/\\\\]", " ").trim();
                    if (!name.isEmpty()) return name.substring(0, Math.min(name.length(), 120));
                }
            }
        } catch (RuntimeException ignored) { /* Names are optional. */ }
        return "导入的原图";
    }

    private File file(String id) { return new File(directory, id + ".image"); }
    private static boolean validId(String id) { return id != null && id.matches("[a-f0-9]{64}"); }

    private static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) value.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        return value.toString();
    }

    static final class Entry {
        final File file;
        final String mime;
        Entry(File file, String mime) { this.file = file; this.mime = mime; }
    }
}
