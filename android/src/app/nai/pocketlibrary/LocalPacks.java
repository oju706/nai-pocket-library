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

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.function.IntConsumer;

final class LocalPacks {
    private static final int MAX_IMAGE = 12 * 1024 * 1024;
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
                packs.put(new JSONObject().put("id", id).put("name", stored.getString("name")));
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
            try {
                input.getChannel().position(0);
            } catch (IOException failure) {
                throw new IOException("请把数据包存到手机的下载目录，再从那里选择。", failure);
            }
            FileOutputStream output = target.startWrite();
            try {
                JsonWriter writer = new JsonWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8));
                scan(input, size, writer, progress);
                writer.flush();
                target.finishWrite(output);
            } catch (Exception failure) {
                target.failWrite(output);
                throw new IOException("读取数据包失败。请选择原始画师数据文件。", failure);
            }
        }
        String info = new JSONObject().put("name", name).put("uri", uri.toString()).toString();
        if (!metadata.edit().putString(id, info).commit()) throw new IOException("无法保存数据包目录。");
        return new JSONObject().put("id", id).put("name", name);
    }

    InputStream openIndex(String id) throws IOException {
        if (!validId(id) || !metadata.contains(id)) throw new IOException("Pack missing");
        return new AtomicFile(file(id)).openRead();
    }

    byte[] image(String id, long offset, int length) throws IOException, JSONException {
        if (!validId(id) || offset < 0 || length < 1 || length > MAX_IMAGE || !metadata.contains(id)) {
            throw new IOException("Invalid pack preview");
        }
        Uri uri = Uri.parse(new JSONObject(metadata.getString(id, "")).getString("uri"));
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
