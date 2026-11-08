package app.nai.pocketlibrary;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import android.util.Base64;
import android.util.JsonWriter;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.IntConsumer;

final class LocalPacks {
    private static final int MAX_IMAGE = 12 * 1024 * 1024;
    private static final long MAX_ZIP_STORAGE = 1024L * 1024 * 1024;
    private static final long STORAGE_RESERVE = 16L * 1024 * 1024;
    private static final Object ZIP_IMPORT_LOCK = new Object();
    private final File indexes;
    private final SharedPreferences metadata;
    private final ContentResolver resolver;

    LocalPacks(Context context) {
        indexes = new File(context.getFilesDir(), "pack-indexes");
        metadata = context.getSharedPreferences("local-packs", Context.MODE_PRIVATE);
        resolver = context.getContentResolver();
    }

    JSONArray list() {
        JSONArray packs = new JSONArray();
        for (String id : metadata.getAll().keySet()) {
            if (!validId(id) || !file(id).isFile()) continue;
            try {
                JSONObject stored = new JSONObject(metadata.getString(id, ""));
                packs.put(new JSONObject().put("id", id).put("name", stored.getString("name"))
                        .put("format", stored.optString("format", "original")));
            } catch (JSONException ignored) {
                // Ignore incomplete pack metadata.
            }
        }
        return packs;
    }

    JSONObject index(Uri uri, IntConsumer progress) throws IOException, JSONException {
        String id = UUID.nameUUIDFromBytes(uri.toString().getBytes(StandardCharsets.UTF_8)).toString();
        if (!indexes.isDirectory() && !indexes.mkdirs()) throw new IOException("无法保存目录索引。");
        String name = displayName(uri);
        AtomicFile target = new AtomicFile(file(id));
        ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "r");
        if (descriptor == null) throw new IOException("无法打开所选文件。");
        long size = descriptor.getStatSize();
        try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            boolean seekable = true;
            try {
                input.getChannel().position(0);
            } catch (IOException failure) {
                seekable = false;
            }
            BufferedInputStream buffered = new BufferedInputStream(input);
            if (name.toLowerCase(Locale.ROOT).endsWith(".zip") || hasZipHeader(buffered)) {
                return importZip(buffered, size, name, progress, null);
            }
            if (!seekable) throw new IOException("请把数据包存到手机的下载目录，再从那里选择。");
            FileOutputStream output = target.startWrite();
            try {
                JsonWriter writer = new JsonWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8));
                scan(buffered, size, writer, progress);
                writer.flush();
                target.finishWrite(output);
            } catch (Exception failure) {
                target.failWrite(output);
                throw new IOException("读取失败。请选择原始画师数据文件或自制图片 ZIP。", failure);
            }
        }
        String info = new JSONObject().put("name", name).put("uri", uri.toString()).toString();
        if (!metadata.edit().putString(id, info).commit()) throw new IOException("无法保存数据包目录。");
        return new JSONObject().put("id", id).put("name", name);
    }

    private static boolean hasZipHeader(BufferedInputStream input) throws IOException {
        input.mark(4);
        int p = input.read();
        int k = input.read();
        int kind = input.read();
        int version = input.read();
        input.reset();
        return p == 'P' && k == 'K' && ((kind == 3 && version == 4) || (kind == 5 && version == 6));
    }

    private JSONObject importZip(InputStream source, long size, String name, IntConsumer progress,
                                 RemotePackZip.Download remote) throws IOException, JSONException {
        if (size > ImagePackZip.MAX_ZIP_BYTES) throw new IOException("ZIP 文件超过 256 MB，请拆成多个图包。");
        synchronized (ZIP_IMPORT_LOCK) {
            long budget = Math.min(ImagePackZip.MAX_ZIP_BYTES, MAX_ZIP_STORAGE - storedZipBytes());
            budget = Math.min(budget, indexes.getUsableSpace() - STORAGE_RESERVE);
            if (budget <= 0) throw new IOException("没有足够空间导入 ZIP 图包。");
            File staged = File.createTempFile("zip-import-", ".tmp", indexes);
            try {
                progress.accept(-1);
                ImagePackZip.Index index;
                try (FileOutputStream output = new FileOutputStream(staged)) {
                    index = ImagePackZip.read(source, output, MAX_IMAGE, budget);
                }
                if (remote != null) remote.finish();
                File data = zipDataFile(index.id);
                File catalogue = file(index.id);
                if (metadata.contains(index.id) && catalogue.isFile() && data.isFile()) {
                    JSONObject old = new JSONObject(metadata.getString(index.id, ""));
                    progress.accept(100);
                    return zipSummary(index.id, old.getString("name"));
                }
                if (data.exists() && !data.delete()) throw new IOException("无法清理旧的导入记录。");
                if (!staged.renameTo(data)) throw new IOException("无法保存图包图片。");
                AtomicFile target = new AtomicFile(catalogue);
                boolean committed = false;
                try {
                    FileOutputStream output = target.startWrite();
                    try {
                        JsonWriter writer = new JsonWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8));
                        writer.beginArray();
                        for (Map.Entry<String, List<ImagePackZip.Span>> row : index.rows.entrySet()) {
                            writer.beginArray().value(row.getKey()).beginArray();
                            for (ImagePackZip.Span image : row.getValue()) {
                                writer.beginArray().value(image.offset).value(image.length).endArray();
                            }
                            writer.endArray().endArray();
                        }
                        writer.endArray();
                        writer.flush();
                        target.finishWrite(output);
                    } catch (IOException | RuntimeException failure) {
                        target.failWrite(output);
                        throw failure;
                    }
                    String info = new JSONObject().put("name", name).put("format", "zip").toString();
                    if (!metadata.edit().putString(index.id, info).commit()) throw new IOException("无法保存图包目录。");
                    committed = true;
                } finally {
                    if (!committed) {
                        metadata.edit().remove(index.id).commit();
                        target.delete();
                        data.delete();
                    }
                }
                progress.accept(100);
                return zipSummary(index.id, name);
            } finally {
                staged.delete();
            }
        }
    }

    JSONObject importRemoteZip(String url, IntConsumer progress) throws IOException, JSONException {
        if (progress == null) throw new IllegalArgumentException("progress");
        if (!indexes.isDirectory() && !indexes.mkdirs()) throw new IOException("无法保存目录索引。");
        progress.accept(-1);
        try (RemotePackZip.Download download = RemotePackZip.open(url, progress)) {
            return importZip(download.input(), download.size(), download.name(), value -> {
                if (value == 100) progress.accept(100);
            }, download);
        }
    }

    private long storedZipBytes() {
        long size = 0;
        File[] files = indexes.listFiles();
        if (files == null) return size;
        for (File stored : files) {
            String name = stored.getName();
            if (name.startsWith("zip-import-") && name.endsWith(".tmp")) {
                stored.delete();
            } else if (name.endsWith(".zip-data")) {
                String id = name.substring(0, name.length() - ".zip-data".length());
                if (!validId(id)) continue;
                if (metadata.contains(id) && file(id).isFile()) size += stored.length();
                else if (!stored.delete()) size += stored.length();
            }
        }
        return size;
    }

    private static JSONObject zipSummary(String id, String name) throws JSONException {
        return new JSONObject().put("id", id).put("name", name).put("format", "zip");
    }

    InputStream openIndex(String id) throws IOException {
        if (!validId(id) || !metadata.contains(id)) throw new IOException("Pack missing");
        return new AtomicFile(file(id)).openRead();
    }

    byte[] image(String id, long offset, int length) throws IOException, JSONException {
        if (!validId(id) || offset < 0 || length < 1 || length > MAX_IMAGE || !metadata.contains(id)) {
            throw new IOException("Invalid pack preview");
        }
        JSONObject info = new JSONObject(metadata.getString(id, ""));
        if ("zip".equals(info.optString("format"))) {
            try (RandomAccessFile data = new RandomAccessFile(zipDataFile(id), "r")) {
                if (offset > data.length() - length) throw new IOException("Invalid ZIP image span");
                byte[] image = new byte[length];
                data.seek(offset);
                data.readFully(image);
                return image;
            }
        }
        Uri uri = Uri.parse(info.getString("uri"));
        ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "r");
        if (descriptor == null) throw new IOException("Pack moved");
        try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            input.getChannel().position(offset);
            byte[] raw = new byte[length];
            int read = 0;
            while (read < length) {
                int count = input.read(raw, read, length - read);
                if (count < 0) throw new EOFException();
                read += count;
            }
            String encoded = new String(raw, StandardCharsets.US_ASCII);
            if (encoded.indexOf('\\') >= 0) encoded = (String) new JSONTokener("\"" + encoded + "\"").nextValue();
            if (encoded.startsWith("data:image/")) {
                int comma = encoded.indexOf(',');
                if (comma < 0) throw new IOException("Invalid image data");
                encoded = encoded.substring(comma + 1);
            }
            return Base64.decode(encoded, Base64.DEFAULT);
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) return cursor.getString(0);
        }
        return "已导入画师库";
    }

    private File file(String id) {
        return new File(indexes, id + ".json");
    }

    private File zipDataFile(String id) {
        return new File(indexes, id + ".zip-data");
    }

    private static boolean validId(String id) {
        return id.matches("[a-f0-9-]{36}");
    }

    static void scan(InputStream input, long size, JsonWriter writer, IntConsumer progress) throws IOException, JSONException {
        Scan scan = new Scan(input, size, progress);
        int token = scan.next();
        if (token == 0xef) {
            scan.expect(0xbb, scan.next());
            scan.expect(0xbf, scan.next());
            token = scan.next();
        }
        scan.expect('{', scan.skipSpace(token));
        writer.beginArray();
        token = scan.token();
        int count = 0;
        while (token != '}') {
            scan.expect('"', token);
            String tag = scan.tag();
            scan.expect(':', scan.token());
            scan.expect('[', scan.token());
            writer.beginArray().value(tag).beginArray();
            token = scan.token();
            if (token != ']') {
                while (true) {
                    if (token == '"') {
                        long start = scan.position;
                        scan.skipString();
                        long length = scan.position - start - 1;
                        if (length > 0 && length <= MAX_IMAGE) writer.beginArray().value(start).value(length).endArray();
                    } else {
                        scan.expect('n', token);
                        scan.expect('u', scan.next());
                        scan.expect('l', scan.next());
                        scan.expect('l', scan.next());
                    }
                    token = scan.token();
                    if (token == ']') break;
                    scan.expect(',', token);
                    token = scan.token();
                }
            }
            writer.endArray().endArray();
            if (++count > 150000) throw new IOException("Too many entries");
            token = scan.token();
            if (token == '}') break;
            scan.expect(',', token);
            token = scan.token();
            if (token == '}') throw new IOException("Trailing comma");
        }
        writer.endArray();
        if (count == 0 || scan.token() != -1) throw new IOException("Invalid index");
        progress.accept(100);
    }

    private static final class Scan {
        final InputStream input;
        final long size;
        final IntConsumer progress;
        final byte[] buffer = new byte[131072];
        int cursor;
        int length;
        long position;
        long nextProgress;

        Scan(InputStream input, long size, IntConsumer progress) {
            this.input = input;
            this.size = size;
            this.progress = progress;
        }

        int next() throws IOException {
            if (cursor == length) {
                length = input.read(buffer);
                cursor = 0;
                if (length < 0) { length = 0; return -1; }
                if (position >= nextProgress) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("Interrupted");
                    progress.accept(size > 0 ? (int) Math.min(99, position * 100 / size) : -1);
                    nextProgress = position + 16 * 1024 * 1024;
                }
            }
            position++;
            return buffer[cursor++] & 255;
        }

        int token() throws IOException {
            return skipSpace(next());
        }

        int skipSpace(int ch) throws IOException {
            while (ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t') ch = next();
            return ch;
        }

        void expect(int expected, int actual) throws IOException {
            if (expected != actual) throw new IOException("Invalid JSON at byte " + position);
        }

        String tag() throws IOException, JSONException {
            ByteArrayOutputStream text = new ByteArrayOutputStream();
            text.write('"');
            boolean escape = false;
            for (int ch; (ch = next()) >= 0;) {
                text.write(ch);
                if (!escape && ch == '"') {
                    Object parsed = new JSONTokener(new String(text.toByteArray(), StandardCharsets.UTF_8)).nextValue();
                    if (!(parsed instanceof String) || ((String) parsed).trim().isEmpty()) throw new IOException("Empty tag");
                    return (String) parsed;
                }
                if (text.size() > 4096) throw new IOException("Tag too long");
                escape = !escape && ch == '\\';
            }
            throw new EOFException();
        }

        void skipString() throws IOException {
            boolean escape = false;
            for (int ch; (ch = next()) >= 0;) {
                if (!escape && ch == '"') return;
                if (ch < 32) throw new IOException("Invalid image string");
                escape = !escape && ch == '\\';
            }
            throw new EOFException();
        }
    }
}
