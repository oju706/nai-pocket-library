package app.nai.pocketlibrary;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.CRC32;
import java.util.zip.InflaterInputStream;
import java.util.zip.GZIPInputStream;

/** Local PNG text and NovelAI alpha-channel metadata reader. No network access. */
final class ImagePrompts {
    static final int PICK = 73;
    static final int MAX_INPUT = 32 * 1024 * 1024;
    static final int MAX_FIELD = 1024 * 1024;
    static final int MAX_METADATA = 2 * 1024 * 1024;
    static final int MAX_PIXELS = 8_000_000;
    private static final byte[] SIGNATURE = { (byte)137, 80, 78, 71, 13, 10, 26, 10 };

    interface Result { void complete(int id, Object value, String error); }

    private final Activity activity;
    private final Result result;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private volatile InputStream activeStream;
    private boolean busy;
    private int requestId;

    ImagePrompts(Activity activity, Result result) {
        this.activity = activity;
        this.result = result;
    }

    boolean isBusy() { return busy; }

    void readImagePrompts(int id) {
        if (destroyed) return;
        if (busy) {
            result.complete(id, null, "已有原图正在读取。");
            return;
        }
        busy = true;
        requestId = id;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { activity.startActivityForResult(intent, PICK); }
        catch (RuntimeException failure) { finish(null, "无法打开图片文件选择器。"); }
    }

    boolean handleActivityResult(int code, int response, Intent data) {
        if (code != PICK) return false;
        if (!busy || destroyed) return true;
        Uri uri = data == null ? null : data.getData();
        if (response != Activity.RESULT_OK || uri == null) {
            finish(null, null);
            return true;
        }
        if (!"content".equals(uri.getScheme())) {
            finish(null, "请选择手机文件中的 PNG 原图。");
            return true;
        }
        worker.execute(() -> {
            try (InputStream input = activity.getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IOException("无法读取这张原图。");
                activeStream = input;
                if (destroyed) return;
                PngData png = readPng(input);
                JSONObject summary = summarize(png.fields);
                boolean hasPrompt = !summary.optString("prompt").isEmpty() || !summary.optString("negativePrompt").isEmpty()
                        || summary.getJSONArray("characters").length() > 0 || summary.getJSONArray("negativeCharacters").length() > 0;
                if (!hasPrompt && (png.colorType == 4 || png.colorType == 6 || png.colorType == 3)) {
                    try {
                        Map<String, String> hidden = readAlpha(uri, png);
                        if (hidden != null) {
                            Map<String, String> combined = new LinkedHashMap<>(png.fields);
                            combined.putAll(hidden);
                            summary = summarize(combined);
                            summary.put("metadataType", "PNG alpha stealth");
                            summary.put("message", summary.optBoolean("found")
                                    ? "已读取图片透明通道中的提示词信息。"
                                    : "读取到图片隐藏数据，但没有找到提示词。");
                        }
                    } catch (IOException failure) {
                        // Keep any readable text metadata when the optional alpha fallback is unavailable.
                        summary.put("message", failure.getMessage());
                        summary.put("alphaReadError", failure.getMessage());
                    }
                }
                finish(summary, null);
            } catch (Exception failure) {
                finish(null, failure instanceof IOException && failure.getMessage() != null
                        ? failure.getMessage() : "无法读取原图提示词，请选择未经转存压缩的 PNG 文件。");
            } finally { activeStream = null; }
        });
        return true;
    }

    /** Streams through PNG text without allocating image pixels. */
    static Map<String, String> readMetadata(InputStream stream) throws IOException {
        return readPng(stream).fields;
    }

    private static final class PngData {
        final Map<String, String> fields = new LinkedHashMap<>();
        int width;
        int height;
        int depth;
        int colorType;
    }

    private static PngData readPng(InputStream stream) throws IOException {
        DataInputStream input = new DataInputStream(stream);
        byte[] signature = new byte[8];
        try { input.readFully(signature); }
        catch (EOFException failure) { throw new IOException("文件不是完整的 PNG 原图。"); }
        if (!Arrays.equals(signature, SIGNATURE)) throw new IOException("目前支持读取 PNG 原图，请选择 NovelAI 直接保存的 PNG 文件。");
        PngData png = new PngData();
        int consumed = 8;
        int metadataBytes = 0;
        byte[] buffer = new byte[32768];
        boolean header = false;
        try {
            for (int chunkNumber = 0; chunkNumber < 10000; chunkNumber++) {
                long length = Integer.toUnsignedLong(input.readInt());
                byte[] name = new byte[4];
                input.readFully(name);
                for (byte letter : name) {
                    if (!((letter >= 'A' && letter <= 'Z') || (letter >= 'a' && letter <= 'z'))) {
                        throw new IOException("PNG 文件结构不完整或已损坏。");
                    }
                }
                if (length > MAX_INPUT - consumed - 12L) throw new IOException("原图超过 32 MB 或 PNG 数据块长度异常。");
                consumed += (int)length + 12;
                String type = new String(name, StandardCharsets.US_ASCII);
                if (!header) {
                    if (!"IHDR".equals(type) || length != 13) throw new IOException("PNG 缺少有效的图片头。");
                    header = true;
                } else if ("IHDR".equals(type)) {
                    throw new IOException("PNG 图片头重复，无法读取。");
                }
                boolean text = "tEXt".equals(type) || "iTXt".equals(type) || "zTXt".equals(type);
                if (text && length > MAX_FIELD) throw new IOException("原图中的单个文本字段超过 1 MB，暂时无法读取。");
                boolean capture = text || "IHDR".equals(type);
                byte[] content = capture ? new byte[(int)length] : null;
                CRC32 crc = new CRC32();
                crc.update(name);
                int remaining = (int)length;
                if (capture) {
                    input.readFully(content);
                    crc.update(content);
                } else {
                    while (remaining > 0) {
                        int count = Math.min(buffer.length, remaining);
                        input.readFully(buffer, 0, count);
                        crc.update(buffer, 0, count);
                        remaining -= count;
                    }
                }
                long expectedCrc = Integer.toUnsignedLong(input.readInt());
                if (crc.getValue() != expectedCrc) throw new IOException("PNG 数据校验失败，请重新保存原图。");
                if ("IHDR".equals(type)) {
                    ByteBuffer dimensions = ByteBuffer.wrap(content);
                    png.width = dimensions.getInt();
                    png.height = dimensions.getInt();
                    png.depth = content[8] & 255;
                    png.colorType = content[9] & 255;
                    if (png.width <= 0 || png.height <= 0) throw new IOException("PNG 图片尺寸异常。");
                }
                if (text) {
                    TextField field = decodeText(type, content);
                    metadataBytes += field.bytes;
                    if (metadataBytes > MAX_METADATA) throw new IOException("原图中的文本信息超过 2 MB，暂时无法读取。");
                    png.fields.put(field.key, field.value);
                }
                if ("IEND".equals(type)) {
                    if (length != 0) throw new IOException("PNG 结束标记异常。");
                    return png;
                }
            }
            throw new IOException("PNG 数据块过多，暂时无法读取。");
        } catch (EOFException failure) {
            throw new IOException("PNG 文件不完整，请重新保存原图。");
        }
    }

    private Map<String, String> readAlpha(Uri uri, PngData png) throws IOException {
        long pixels = (long)png.width * png.height;
        if (pixels > MAX_PIXELS || png.width > 16384 || png.height > 16384) {
            throw new IOException("未找到提示词文本；隐藏信息读取最多支持 800 万像素的 PNG 原图。");
        }
        if (png.depth == 16) throw new IOException("未找到提示词文本；暂不支持 16 位 PNG 的隐藏信息。");
        if (pixels * 4 > Runtime.getRuntime().maxMemory() / 3) {
            throw new IOException("原图较大，当前手机内存不足以读取隐藏信息。");
        }
        Bitmap bitmap = null;
        try (InputStream input = activity.getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("无法重新读取原图中的隐藏信息。");
            activeStream = input;
            if (destroyed) throw new IOException("读取已取消。");
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inPreferredConfig = Bitmap.Config.ARGB_8888;
            options.inPremultiplied = false;
            options.inScaled = false;
            options.inDither = false;
            options.inSampleSize = 1;
            bitmap = BitmapFactory.decodeStream(new LimitedInput(input), null, options);
            if (bitmap == null || bitmap.getWidth() != png.width || bitmap.getHeight() != png.height) {
                throw new IOException("无法解码 PNG 原图中的隐藏信息。");
            }
            if (!bitmap.hasAlpha()) return null;
            final Bitmap decoded = bitmap;
            final int[] column = new int[png.height];
            AlphaPixels source = new AlphaPixels() {
                int currentColumn = -1;
                public int alpha(int x, int y) {
                    if (currentColumn != x) {
                        if (destroyed) throw new IllegalStateException("读取已取消。");
                        decoded.getPixels(column, 0, 1, x, 0, 1, png.height);
                        currentColumn = x;
                    }
                    return (column[y] >>> 24) & 255;
                }
            };
            String raw = extractAlpha(png.width, png.height, source);
            if (raw == null) return null;
            if (!safeDepth(raw)) throw new IOException("图片隐藏信息的数据层次异常，无法读取。");
            JSONObject root;
            try { root = new JSONObject(raw); }
            catch (org.json.JSONException failure) { throw new IOException("图片的隐藏信息不是有效的 JSON 内容。"); }
            Map<String, String> fields = new LinkedHashMap<>();
            Iterator<String> keys = root.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = root.opt(key);
                if (value == null || value == JSONObject.NULL) continue;
                String text = value instanceof String ? (String)value : value.toString();
                if (text.getBytes(StandardCharsets.UTF_8).length > MAX_FIELD) {
                    throw new IOException("隐藏信息中的单个文本字段超过 1 MB，暂时无法读取。");
                }
                fields.put(key, text);
            }
            return fields;
        } catch (OutOfMemoryError tooLarge) {
            throw new IOException("当前手机内存不足，请关闭其他应用后再读取这张原图。");
        } finally {
            if (bitmap != null) bitmap.recycle();
            activeStream = null;
        }
    }

    private static final class LimitedInput extends FilterInputStream {
        int count;
        LimitedInput(InputStream input) { super(input); }
        public int read() throws IOException {
            if (count >= MAX_INPUT) throw new IOException("原图超过 32 MB。");
            int value = in.read();
            if (value >= 0) count++;
            return value;
        }
        public int read(byte[] bytes, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (count >= MAX_INPUT) throw new IOException("原图超过 32 MB。");
            int read = in.read(bytes, offset, Math.min(length, MAX_INPUT - count));
            if (read > 0) count += read;
            return read;
        }
        public long skip(long n) throws IOException {
            if (n <= 0) return 0;
            if (count >= MAX_INPUT) throw new IOException("原图超过 32 MB。");
            long skipped = in.skip(Math.min(n, (long)MAX_INPUT - count));
            count += (int)skipped;
            return skipped;
        }
        public boolean markSupported() { return false; }
    }

    interface AlphaPixels { int alpha(int x, int y); }

    /*
     * Format reference: NovelAI/novelai-image-metadata, nai_meta.py (MIT, NovelAI 2023).
     * https://github.com/NovelAI/novelai-image-metadata
     * Independently implemented here: column-major alpha LSB, MSB-first bytes,
     * 15-byte marker, big-endian 32-bit payload length in bits, UTF-8 JSON.
     * pngcomp uses gzip. pnginfo is the uncompressed compatible variant.
     */
    static String extractAlpha(int width, int height, AlphaPixels pixels) throws IOException {
        long capacity = (long)width * height;
        if (width <= 0 || height <= 0 || capacity < 19 * 8) return null;
        AlphaBits bits = new AlphaBits(height, capacity, pixels);
        byte[] magicBytes = new byte[15];
        for (int i = 0; i < magicBytes.length; i++) magicBytes[i] = (byte)bits.nextByte();
        String magic = new String(magicBytes, StandardCharsets.US_ASCII);
        boolean compressed = "stealth_pngcomp".equals(magic);
        if (!compressed && !"stealth_pnginfo".equals(magic)) return null;
        long bitLength = 0;
        for (int i = 0; i < 4; i++) bitLength = (bitLength << 8) | bits.nextByte();
        if (bitLength == 0 || bitLength % 8 != 0 || bitLength > (long)MAX_FIELD * 8
                || bitLength > capacity - bits.position) {
            throw new IOException("PNG 隐藏信息长度异常或超过读取上限。");
        }
        byte[] payload = new byte[(int)(bitLength / 8)];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte)bits.nextByte();
        byte[] json = payload;
        if (compressed) {
            try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(payload))) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int count; (count = gzip.read(buffer)) >= 0;) {
                    if (count > MAX_METADATA - output.size()) throw new IOException("Hidden text too large");
                    output.write(buffer, 0, count);
                }
                json = output.toByteArray();
            } catch (IOException failure) {
                throw new IOException("PNG 隐藏信息损坏，或解压后超过 2 MB。");
            }
        }
        return utf8(json);
    }

    private static final class AlphaBits {
        final int height;
        final long capacity;
        final AlphaPixels pixels;
        long position;
        AlphaBits(int height, long capacity, AlphaPixels pixels) {
            this.height = height;
            this.capacity = capacity;
            this.pixels = pixels;
        }
        int nextByte() throws IOException {
            if (position + 8 > capacity) throw new IOException("PNG 隐藏信息不完整。");
            int value = 0;
            for (int i = 0; i < 8; i++, position++) {
                int x = (int)(position / height);
                int y = (int)(position % height);
                value = (value << 1) | (pixels.alpha(x, y) & 1);
            }
            return value;
        }
    }

    private static final class TextField {
        final String key;
        final String value;
        final int bytes;
        TextField(String key, String value, int bytes) { this.key = key; this.value = value; this.bytes = bytes; }
    }

    private static TextField decodeText(String type, byte[] content) throws IOException {
        int end = zero(content, 0);
        if (end < 1 || end > 79) throw new IOException("PNG 文本字段名称异常。");
        String key = new String(content, 0, end, StandardCharsets.ISO_8859_1);
        int start = end + 1;
        boolean compressed = false;
        boolean unicode = "iTXt".equals(type);
        if ("zTXt".equals(type)) {
            if (start >= content.length || content[start++] != 0) throw new IOException("无法识别 PNG 文本的压缩方式。");
            compressed = true;
        } else if (unicode) {
            if (start + 2 > content.length) throw new IOException("PNG 国际文本字段不完整。");
            int flag = content[start++] & 255;
            int method = content[start++] & 255;
            if ((flag != 0 && flag != 1) || method != 0) throw new IOException("无法识别 PNG 文本的压缩方式。");
            compressed = flag == 1;
            start = zero(content, start) + 1; // Language tag.
            start = zero(content, start) + 1; // Translated keyword.
        }
        byte[] text;
        if (compressed) {
            try (InflaterInputStream inflater = new InflaterInputStream(new ByteArrayInputStream(content, start, content.length - start))) {
                text = boundedText(inflater);
            } catch (IOException failure) {
                throw new IOException("PNG 压缩文本损坏或解压后超过 1 MB。");
            }
        } else text = Arrays.copyOfRange(content, start, content.length);
        return new TextField(key, unicode ? utf8(text) : new String(text, StandardCharsets.ISO_8859_1), text.length);
    }

    private static int zero(byte[] data, int start) throws IOException {
        for (int i = start; i < data.length; i++) if (data[i] == 0) return i;
        throw new IOException("PNG 文本字段不完整。");
    }

    private static byte[] boundedText(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) >= 0;) {
            if (count > MAX_FIELD - output.size()) throw new IOException("Text too large");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static String utf8(byte[] data) throws IOException {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString();
        } catch (CharacterCodingException failure) { throw new IOException("PNG 文本不是有效的 UTF-8 内容。"); }
    }

    static JSONObject summarize(Map<String, String> fields) throws org.json.JSONException {
        String raw = fields.getOrDefault("Comment", "");
        JSONObject parameters = null;
        if (!raw.isEmpty() && safeDepth(raw)) {
            try { parameters = new JSONObject(raw); }
            catch (org.json.JSONException ignored) { /* Preserve non-JSON comments verbatim. */ }
        }
        JSONObject positive = parameters == null ? null : parameters.optJSONObject("v4_prompt");
        JSONObject negative = parameters == null ? null : parameters.optJSONObject("v4_negative_prompt");
        JSONObject positiveCaption = positive == null ? null : positive.optJSONObject("caption");
        JSONObject negativeCaption = negative == null ? null : negative.optJSONObject("caption");
        JSONArray characters = positiveCaption == null ? null : positiveCaption.optJSONArray("char_captions");
        JSONArray negativeCharacters = negativeCaption == null ? null : negativeCaption.optJSONArray("char_captions");
        String prompt = first(string(parameters, "prompt"), string(positiveCaption, "base_caption"), fields.getOrDefault("Description", ""));
        String negativePrompt = first(string(parameters, "uc"), string(parameters, "negative_prompt"), string(negativeCaption, "base_caption"));
        String model = first(string(parameters, "model"), fields.getOrDefault("Source", ""));
        boolean found = !prompt.isEmpty() || !negativePrompt.isEmpty() || !raw.isEmpty()
                || characters != null && characters.length() > 0 || negativeCharacters != null && negativeCharacters.length() > 0;
        JSONObject result = new JSONObject();
        result.put("found", found);
        result.put("prompt", prompt);
        result.put("negativePrompt", negativePrompt);
        result.put("model", model);
        result.put("rawComment", raw);
        result.put("parameters", parameters == null ? JSONObject.NULL : parameters);
        result.put("characters", characters == null ? new JSONArray() : characters);
        result.put("negativeCharacters", negativeCharacters == null ? new JSONArray() : negativeCharacters);
        result.put("v4Prompt", positive == null ? JSONObject.NULL : positive);
        result.put("v4NegativePrompt", negative == null ? JSONObject.NULL : negative);
        result.put("metadata", new JSONObject(fields));
        result.put("metadataType", "PNG text");
        result.put("message", found ? "已读取图片内的文本信息。"
                : "未找到可读取的提示词。图片可能没有保存提示词，或已被截图、压缩、转存清除。");
        return result;
    }

    private static String string(JSONObject object, String key) {
        Object value = object == null ? null : object.opt(key);
        return value instanceof String ? (String)value : "";
    }

    private static boolean safeDepth(String json) {
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
                if (++depth > 64) return false;
            } else if (c == '}' || c == ']') depth--;
        }
        return true;
    }

    private static String first(String... values) {
        for (String value : values) if (value != null && !value.isEmpty()) return value;
        return "";
    }

    private void finish(Object value, String error) {
        activity.runOnUiThread(() -> {
            if (destroyed || !busy) return;
            int id = requestId;
            busy = false;
            result.complete(id, value, error);
        });
    }

    void cancelOnDestroy() {
        destroyed = true;
        busy = false;
        InputStream input = activeStream;
        if (input != null) try { input.close(); } catch (IOException ignored) {}
        worker.shutdownNow();
    }
}
