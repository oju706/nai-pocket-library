package app.nai.pocketlibrary;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicit user-selected JSON backups. No storage permission or network is needed. */
final class LibraryBackup {
    static final int EXPORT = 71;
    static final int IMPORT = 72;
    static final int MAX_BYTES = 20 * 1024 * 1024;

    interface Result { void complete(int id, Object value, String error); }

    private final Activity activity;
    private final Result result;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private volatile Closeable activeStream;
    private int operation;
    private int requestId;
    private byte[] exportData;

    LibraryBackup(Activity activity, Result result) {
        this.activity = activity;
        this.result = result;
    }

    boolean isBusy() { return operation != 0; }

    void exportBackup(int id, String json) {
        if (!begin(id, EXPORT)) return;
        worker.execute(() -> {
            try {
                if (json == null || json.length() > MAX_BYTES) throw new IOException("备份超过 20 MB，请减少本机配图后再导出。");
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BYTES) throw new IOException("备份超过 20 MB，请减少本机配图后再导出。");
                validate(json);
                activity.runOnUiThread(() -> {
                    if (destroyed) return;
                    exportData = bytes;
                    String stamp = new SimpleDateFormat("yyyy-MM-dd_HHmm", Locale.ROOT).format(new Date());
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE).setType("application/json")
                            .putExtra(Intent.EXTRA_TITLE, "NAI-pocket-backup-" + stamp + ".json");
                    launch(intent, EXPORT);
                });
            } catch (Exception failure) {
                finish(null, message(failure, "无法准备备份文件，请重试。"));
            }
        });
    }

    void importBackup(int id) {
        if (!begin(id, IMPORT)) return;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES,
                        new String[] { "application/json", "application/octet-stream", "text/plain" });
        launch(intent, IMPORT);
    }

    private boolean begin(int id, int action) {
        if (destroyed) return false;
        if (isBusy()) {
            result.complete(id, null, "已有备份操作正在进行。");
            return false;
        }
        operation = action;
        requestId = id;
        return true;
    }

    private void launch(Intent intent, int code) {
        try { activity.startActivityForResult(intent, code); }
        catch (RuntimeException failure) { finish(null, "无法打开系统文件选择器。"); }
    }

    boolean handleActivityResult(int code, int response, Intent data) {
        if (code != EXPORT && code != IMPORT) return false;
        if (operation != code || destroyed) return true;
        Uri uri = data == null ? null : data.getData();
        if (response != Activity.RESULT_OK || uri == null) {
            finish(null, null);
            return true;
        }
        if (!"content".equals(uri.getScheme())) {
            finish(null, "请选择手机文件中的备份文件。");
            return true;
        }
        final byte[] bytes = exportData;
        exportData = null;
        worker.execute(() -> {
            try {
                if (code == EXPORT) {
                    if (bytes == null) throw new IOException("备份内容已失效，请重新导出。");
                    try (OutputStream output = activity.getContentResolver().openOutputStream(uri, "wt")) {
                        if (output == null) throw new IOException("无法写入这个位置。");
                        setActive(output);
                        output.write(bytes);
                        output.flush();
                    } finally { activeStream = null; }
                    finish(true, null);
                } else {
                    String json;
                    try (InputStream input = activity.getContentResolver().openInputStream(uri)) {
                        if (input == null) throw new IOException("无法读取这个文件。");
                        setActive(input);
                        json = decode(readBounded(input));
                    } finally { activeStream = null; }
                    validate(json);
                    finish(json, null);
                }
            } catch (Exception failure) {
                finish(null, message(failure, code == EXPORT ? "备份写入失败，请检查剩余空间后重试。" : "无法读取备份，请选择本应用导出的 JSON 文件。"));
            }
        });
        return true;
    }

    private void setActive(Closeable stream) throws IOException {
        activeStream = stream;
        if (destroyed) {
            stream.close();
            throw new IOException("操作已取消。");
        }
    }

    private static byte[] readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[32768];
        for (int n; (n = input.read(buffer)) >= 0;) {
            if (n > MAX_BYTES - bytes.size()) throw new IOException("备份超过 20 MB，暂时无法导入。");
            bytes.write(buffer, 0, n);
        }
        return bytes.toByteArray();
    }

    private static String decode(byte[] bytes) throws IOException {
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return text.startsWith("\uFEFF") ? text.substring(1) : text;
        } catch (CharacterCodingException failure) {
            throw new IOException("文件不是有效的 UTF-8 JSON 备份。");
        }
    }

    private static void validate(String json) throws IOException {
        try {
            validateDepth(json);
            JSONObject root = new JSONObject(json);
            if (!"nai-pocket-library".equals(root.optString("format")) || root.optInt("version", -1) != 1
                    || root.optJSONArray("cards") == null) throw new IOException("不是本应用支持的备份格式。");
        } catch (org.json.JSONException failure) {
            throw new IOException("文件不是有效的 JSON 备份。");
        }
    }

    private static void validateDepth(String json) throws IOException {
        int depth = 0;
        boolean quoted = false;
        boolean escaped = false;
        for (int i = 0; i < json.length(); i++) {
            char c = json.charAt(i);
            if (quoted) {
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') quoted = false;
            } else if (c == '"') quoted = true;
            else if (c == '{' || c == '[') {
                if (++depth > 64) throw new IOException("备份的数据层次异常，无法导入。");
            } else if (c == '}' || c == ']') depth--;
        }
    }

    private static String message(Exception failure, String fallback) {
        return failure instanceof IOException && failure.getMessage() != null ? failure.getMessage() : fallback;
    }

    private void finish(Object value, String error) {
        activity.runOnUiThread(() -> {
            if (destroyed || operation == 0) return;
            int id = requestId;
            operation = 0;
            exportData = null;
            result.complete(id, value, error);
        });
    }

    void cancelOnDestroy() {
        destroyed = true;
        operation = 0;
        exportData = null;
        Closeable stream = activeStream;
        if (stream != null) try { stream.close(); } catch (IOException ignored) {}
        worker.shutdownNow();
    }
}
