package app.nai.pocketlibrary;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PushbackInputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.CRC32;
import java.util.zip.InflaterInputStream;
import java.util.zip.GZIPInputStream;

/** Local PNG, JPEG/WebP EXIF and NovelAI alpha-channel metadata reader. No network access. */
final class ImagePrompts {
    static final int PICK = 73;
    static final int MAX_INPUT = 32 * 1024 * 1024;
    static final int MAX_FIELD = 1024 * 1024;
    static final int MAX_METADATA = 2 * 1024 * 1024;
    static final int MAX_PIXELS = 8_000_000;
    private static final int MAX_TEXT_FIELDS = 128;
    private static final int MAX_IFD_ENTRIES = 256;
    private static final int MAX_CONTAINER_CHUNKS = 10000;
    private static final List<String> PARAMETER_WRAPPERS = Arrays.asList("comment", "generation", "request", "settings",
            "parameters", "generationparams", "generationparameters", "generationsettings");
    private static final byte[] SIGNATURE = { (byte)137, 80, 78, 71, 13, 10, 26, 10 };

    interface Result { void complete(int id, Object value, String error); }
    private interface ImageInput { InputStream open() throws IOException; }

    private final Activity activity;
    private final Result result;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private volatile InputStream activeStream;
    private boolean busy;
    private int requestId;
    private Uri lastOriginal;

    ImagePrompts(Activity activity, Result result) {
        this.activity = activity;
        this.result = result;
    }

    boolean isBusy() { return busy; }

    Uri lastOriginal() { return lastOriginal; }

    private boolean begin(int id) {
        if (destroyed) return false;
        if (busy) {
            result.complete(id, null, "已有原图正在读取。");
            return false;
        }
        busy = true;
        requestId = id;
        return true;
    }

    void readImagePrompts(int id) {
        if (!begin(id)) return;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { activity.startActivityForResult(intent, PICK); }
        catch (RuntimeException failure) { finish(null, "无法打开图片文件选择器。"); }
    }

    void readGallery(int id, File file) {
        if (begin(id)) inspect(() -> new FileInputStream(file), false);
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
            finish(null, "请选择手机文件中的原图。");
            return true;
        }
        lastOriginal = uri;
        inspect(() -> activity.getContentResolver().openInputStream(uri), true);
        return true;
    }

    private void inspect(ImageInput source, boolean includePreview) {
        worker.execute(() -> {
            try (InputStream input = source.open()) {
                if (input == null) throw new IOException("无法读取这张原图。");
                activeStream = input;
                if (destroyed) return;
                ImageData image = readImage(input);
                JSONObject summary = summarize(image.fields, image.metadataType, image.missingReason);
                boolean hasPrompt = !summary.optString("prompt").isEmpty() || !summary.optString("negativePrompt").isEmpty()
                        || summary.getJSONArray("characters").length() > 0 || summary.getJSONArray("negativeCharacters").length() > 0;
                if (image.webpAlpha || (image.png && (image.colorType == 4 || image.colorType == 6 || image.colorType == 3))) {
                    try {
                        Map<String, String> hidden = readAlpha(source, image);
                        if (hidden != null) {
                            Map<String, String> combined = mergeFields(image.fields, hidden);
                            String type = (image.png ? "PNG" : "WebP") + (image.fields.isEmpty() ? " alpha stealth" : " metadata + alpha stealth");
                            summary = summarize(combined, type, "");
                            summary.put("message", summary.optBoolean("found")
                                    ? "已读取图片透明通道中的提示词信息。"
                                    : "读取到图片隐藏数据，但没有找到提示词。");
                        }
                    } catch (Exception failure) {
                        // Keep all readable text metadata; alpha is a supplementary source, not a gate.
                        String reason = failure.getMessage() == null
                                ? "无法读取图片透明通道中的隐藏信息。" : failure.getMessage();
                        if (!hasPrompt) {
                            summary.put("message", reason);
                            summary.put("missingReason", reason);
                        }
                        summary.put("alphaReadError", reason);
                    }
                }
                if (includePreview) {
                    String preview = readPreview(source, image);
                    if (preview != null) summary.put("preview", preview);
                }
                if (summary.toString().length() > 3 * MAX_FIELD) throw new IOException("这张图的生成信息过大，无法在预览页完整显示。");
                finish(summary, null);
            } catch (Exception failure) {
                finish(null, failure instanceof IOException && failure.getMessage() != null
                        ? failure.getMessage() : "无法读取原图提示词，请选择未经转存压缩的原图。");
            } finally { activeStream = null; }
        });
    }

    /** Streams through PNG text without allocating image pixels. */
    static Map<String, String> readMetadata(InputStream stream) throws IOException {
        return readImage(stream).fields;
    }

    private static final class ImageData {
        final Map<String, String> fields = new LinkedHashMap<>();
        String metadataType;
        String missingReason = "";
        boolean png;
        boolean webpAlpha;
        int width;
        int height;
        int depth;
        int colorType;
        ImageData(String metadataType) { this.metadataType = metadataType; }
    }

    private static ImageData readImage(InputStream stream) throws IOException {
        PushbackInputStream input = new PushbackInputStream(stream, 12);
        byte[] head = new byte[12];
        int count = 0;
        while (count < head.length) {
            int read = input.read(head, count, head.length - count);
            if (read < 0) break;
            count += read;
        }
        if (count > 0) input.unread(head, 0, count);
        if (count >= SIGNATURE.length && Arrays.equals(Arrays.copyOf(head, SIGNATURE.length), SIGNATURE)) {
            return readPng(input);
        }
        if (count >= 2 && (head[0] & 255) == 0xff && (head[1] & 255) == 0xd8) {
            return readJpeg(input);
        }
        if (count >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') {
            return readWebp(input);
        }
        throw new IOException("目前支持读取 PNG、JPEG EXIF/COM 与 WebP EXIF，请选择未经截图或转存的原图。");
    }

    private static ImageData readPng(InputStream stream) throws IOException {
        DataInputStream input = new DataInputStream(stream);
        byte[] signature = new byte[8];
        try { input.readFully(signature); }
        catch (EOFException failure) { throw new IOException("文件不是完整的 PNG 原图。"); }
        if (!Arrays.equals(signature, SIGNATURE)) throw new IOException("PNG 文件头无效。");
        ImageData png = new ImageData("PNG text");
        png.png = true;
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
                    putField(png.fields, field.key, field.value);
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

    private static ImageData readJpeg(InputStream stream) throws IOException {
        LimitedInput limited = new LimitedInput(stream);
        DataInputStream input = new DataInputStream(limited);
        ImageData image = new ImageData("JPEG EXIF/COM");
        int metadataBytes = 0;
        int comIndex = 0;
        boolean reachedScanOrEnd = false;
        try {
            if (input.readUnsignedShort() != 0xffd8) throw new IOException("JPEG 文件头无效。");
            for (int segment = 0; segment < MAX_CONTAINER_CHUNKS; segment++) {
                int prefix = input.read();
                if (prefix < 0) throw new IOException("JPEG 文件不完整。");
                if (prefix != 0xff) throw new IOException("JPEG 数据段结构异常。");
                int marker;
                do {
                    marker = input.read();
                    if (marker < 0) throw new IOException("JPEG 文件不完整。");
                } while (marker == 0xff);
                if (marker == 0x00) throw new IOException("JPEG 数据段标记异常。");
                if (marker == 0xd9) {
                    reachedScanOrEnd = true;
                    break;
                }
                if (marker == 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
                if (marker == 0xd8) throw new IOException("JPEG 文件头重复。");

                int length = input.readUnsignedShort();
                if (length < 2) throw new IOException("JPEG 数据段长度异常。");
                int payloadLength = length - 2;
                if (marker == 0xda) {
                    skipFully(input, payloadLength);
                    drain(limited);
                    reachedScanOrEnd = true;
                    break;
                }
                byte[] payload = new byte[payloadLength];
                input.readFully(payload);
                if (marker == 0xe1) {
                    if (startsWith(payload, new byte[] {'E', 'x', 'i', 'f', 0, 0})) {
                        Map<String, String> exif = parseExif(payload, 6);
                        metadataBytes = addFields(image.fields, exif, metadataBytes);
                    } else if (startsWith(payload, "http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII))) {
                        image.missingReason = "检测到 JPEG XMP，但本版本不从未经验证的 XMP 推断提示词；仅解析 EXIF/COM。";
                        image.metadataType = "JPEG EXIF/COM (XMP not parsed)";
                    }
                } else if (marker == 0xfe) {
                    String value = decodeJpegText(payload);
                    if (!value.isEmpty()) {
                        metadataBytes += utf8Length(value, "JPEG COM");
                        if (metadataBytes > MAX_METADATA) {
                            throw new IOException("图片中的文本信息超过 2 MB，暂时无法读取。");
                        }
                        String key = comIndex == 0 ? "COM" : "COM." + (comIndex + 1);
                        comIndex++;
                        putField(image.fields, key, value);
                    }
                } else if (isStartOfFrame(marker) && payload.length >= 5) {
                    image.height = ((payload[1] & 255) << 8) | (payload[2] & 255);
                    image.width = ((payload[3] & 255) << 8) | (payload[4] & 255);
                }
            }
            if (!reachedScanOrEnd) throw new IOException("JPEG 数据段过多，暂时无法读取。");
        } catch (EOFException failure) {
            throw new IOException("JPEG 文件不完整。");
        }
        if (image.fields.isEmpty() && image.missingReason.isEmpty()) {
            image.missingReason = "未找到 JPEG EXIF UserComment 或 COM 文本。";
        }
        return image;
    }

    private static ImageData readWebp(InputStream stream) throws IOException {
        LimitedInput limited = new LimitedInput(stream);
        DataInputStream input = new DataInputStream(limited);
        byte[] header = new byte[12];
        try {
            input.readFully(header);
        } catch (EOFException failure) {
            throw new IOException("WebP 文件不完整。");
        }
        if (header[0] != 'R' || header[1] != 'I' || header[2] != 'F' || header[3] != 'F'
                || header[8] != 'W' || header[9] != 'E' || header[10] != 'B' || header[11] != 'P') {
            throw new IOException("WebP 文件头无效。");
        }
        long fileSize = readU32(header, 4, true) + 8L;
        if (fileSize > MAX_INPUT || fileSize < 12) throw new IOException("WebP 文件大小异常或超过 32 MB。");
        ImageData image = new ImageData("WebP EXIF");
        int metadataBytes = 0;
        boolean xmp = false;
        long position = 12;
        boolean chunksComplete = position == fileSize;
        try {
            for (int chunk = 0; chunk < MAX_CONTAINER_CHUNKS && position + 8 <= fileSize; chunk++) {
                byte[] typeBytes = new byte[4];
                input.readFully(typeBytes);
                long length = readU32(input, true);
                position += 8;
                if (length > MAX_INPUT || length > fileSize - position) {
                    throw new IOException("WebP 数据块长度异常。");
                }
                String type = new String(typeBytes, StandardCharsets.US_ASCII);
                if ("EXIF".equals(type)) {
                    if (length > MAX_METADATA) throw new IOException("WebP EXIF 超过 2 MB。");
                    byte[] payload = new byte[(int)length];
                    input.readFully(payload);
                    int offset = startsWith(payload, new byte[] {'E', 'x', 'i', 'f', 0, 0}) ? 6 : 0;
                    metadataBytes = addFields(image.fields, parseExif(payload, offset), metadataBytes);
                } else if ("XMP ".equals(type)) {
                    xmp = true;
                    skipFully(input, length);
                } else if (length >= 5 && ("VP8X".equals(type) || "VP8L".equals(type) || "VP8 ".equals(type))) {
                    byte[] payload = new byte[(int)Math.min(length, 10)];
                    input.readFully(payload);
                    skipFully(input, length - payload.length);
                    readWebpDimensions(type, payload, image);
                } else {
                    if ("ALPH".equals(type)) image.webpAlpha = true;
                    skipFully(input, length);
                }
                position += length;
                if ((length & 1) != 0) {
                    int padding = input.read();
                    if (padding < 0) throw new IOException("WebP 文件不完整。");
                    position++;
                }
                if (position == fileSize) {
                    chunksComplete = true;
                    break;
                }
                if (position > fileSize) throw new IOException("WebP 数据块越界。");
            }
            if (!chunksComplete) {
                drain(limited);
                throw new IOException("WebP 数据块不完整或数量异常。");
            }
        } catch (EOFException failure) {
            throw new IOException("WebP 文件不完整。");
        }
        if (xmp) {
            image.metadataType = "WebP EXIF (XMP not parsed)";
            if (image.fields.isEmpty()) {
                image.missingReason = "检测到 WebP XMP，但本版本只解析可验证的 EXIF 参数，未从 XMP 猜测提示词。";
            }
        } else if (image.fields.isEmpty()) {
            image.missingReason = "未找到 WebP EXIF 中的提示词参数。";
        }
        return image;
    }

    private static void readWebpDimensions(String type, byte[] payload, ImageData image) {
        if ("VP8X".equals(type) && payload.length >= 10) {
            image.webpAlpha |= (payload[0] & 0x10) != 0;
            image.width = readU24(payload, 4) + 1;
            image.height = readU24(payload, 7) + 1;
        } else if ("VP8L".equals(type) && payload.length >= 5 && (payload[0] & 255) == 0x2f) {
            long bits = readU32(payload, 1, true);
            image.webpAlpha |= (bits & (1L << 28)) != 0;
            image.width = (int)(bits & 0x3fff) + 1;
            image.height = (int)((bits >>> 14) & 0x3fff) + 1;
        } else if ("VP8 ".equals(type) && payload.length >= 10
                && (payload[3] & 255) == 0x9d && (payload[4] & 255) == 0x01 && (payload[5] & 255) == 0x2a) {
            image.width = (((payload[6] & 255) | ((payload[7] & 255) << 8)) & 0x3fff);
            image.height = (((payload[8] & 255) | ((payload[9] & 255) << 8)) & 0x3fff);
        }
    }

    private static boolean isStartOfFrame(int marker) {
        return marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
    }

    private static void drain(InputStream input) throws IOException {
        byte[] buffer = new byte[8192];
        while (input.read(buffer) >= 0) { /* Counts against MAX_INPUT. */ }
    }

    private static void skipFully(InputStream input, long length) throws IOException {
        while (length > 0) {
            long skipped = input.skip(length);
            if (skipped > 0) {
                length -= skipped;
                continue;
            }
            if (input.read() < 0) throw new EOFException();
            length--;
        }
    }

    private static String decodeJpegText(byte[] data) {
        int length = data.length;
        while (length > 0 && data[length - 1] == 0) length--;
        return decodeUtf8Loose(data, 0, length);
    }

    private static int utf8Length(String value, String field) throws IOException {
        int bytes = value.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > MAX_FIELD) throw new IOException(field + " 超过 1 MB，暂时无法读取。");
        return bytes;
    }

    private static int addFields(Map<String, String> destination, Map<String, String> source, int metadataBytes)
            throws IOException {
        for (Map.Entry<String, String> entry : source.entrySet()) {
            metadataBytes += utf8Length(entry.getValue(), "EXIF 字段");
            if (metadataBytes > MAX_METADATA) throw new IOException("图片中的文本信息超过 2 MB，暂时无法读取。");
            putField(destination, entry.getKey(), entry.getValue());
        }
        return metadataBytes;
    }

    private static void putField(Map<String, String> fields, String key, String value) throws IOException {
        if (key == null || key.isEmpty() || value == null) return;
        String unique = key;
        int suffix = 2;
        while (fields.containsKey(unique)) {
            if (value.equals(fields.get(unique))) return;
            unique = key + "." + suffix++;
        }
        if (fields.size() >= MAX_TEXT_FIELDS) throw new IOException("图片文本字段过多，暂时无法读取。");
        fields.put(unique, value);
    }

    private static boolean startsWith(byte[] data, byte[] prefix) {
        if (data.length < prefix.length) return false;
        for (int i = 0; i < prefix.length; i++) if (data[i] != prefix[i]) return false;
        return true;
    }

    private static Map<String, String> parseExif(byte[] data, int base) throws IOException {
        Map<String, String> fields = new LinkedHashMap<>();
        if (base < 0 || base + 8 > data.length) throw new IOException("EXIF 数据不完整。");
        boolean little;
        if (data[base] == 'I' && data[base + 1] == 'I') little = true;
        else if (data[base] == 'M' && data[base + 1] == 'M') little = false;
        else throw new IOException("EXIF 字节序标记无效。");
        if (readU16(data, base + 2, little) != 42) throw new IOException("EXIF TIFF 文件头无效。");
        long ifd0 = readU32(data, base + 4, little);
        long exifOffset = readIfd(data, base, ifd0, little, false, fields);
        if (exifOffset > 0) readIfd(data, base, exifOffset, little, true, fields);
        return fields;
    }

    private static long readIfd(byte[] data, int base, long offset, boolean little, boolean exifIfd,
            Map<String, String> fields) throws IOException {
        if (offset == 0) return 0;
        long absolute = base + offset;
        if (absolute < base || absolute + 2 > data.length) throw new IOException("EXIF 目录偏移无效。");
        int position = (int)absolute;
        int count = readU16(data, position, little);
        if (count > MAX_IFD_ENTRIES) throw new IOException("EXIF 目录条目过多，暂时无法读取。");
        long next = 0;
        long exifPointer = 0;
        for (int i = 0; i < count; i++) {
            int entry = position + 2 + i * 12;
            if (entry + 12 > data.length) throw new IOException("EXIF 目录不完整。");
            int tag = readU16(data, entry, little);
            int type = readU16(data, entry + 2, little);
            long components = readU32(data, entry + 4, little);
            if (!exifIfd && tag == 0x8769) {
                exifPointer = readU32(data, entry + 8, little);
                continue;
            }
            String name = exifFieldName(tag, exifIfd);
            if (name == null) continue;
            int unit = exifTypeSize(type);
            long bytes = unit == 0 ? 0 : components * unit;
            if (unit == 0 || bytes <= 0) continue;
            if (bytes > MAX_FIELD || components > MAX_FIELD) throw new IOException("EXIF 字段超过 1 MB。");
            long value;
            if (bytes <= 4) value = entry + 8;
            else value = base + readU32(data, entry + 8, little);
            if (value < 0 || value + bytes > data.length) throw new IOException("EXIF 字段偏移无效。");
            String text = tag == 0x9286
                    ? decodeUserComment(data, (int)value, (int)bytes)
                    : tag == 0x9c9c || tag == 0x9c9e || tag == 0x9c9f
                    ? decodeUtf16Loose(data, (int)value, (int)bytes, true)
                    : decodeExifText(data, (int)value, (int)bytes);
            if (!text.isEmpty()) putField(fields, name, text);
        }
        int nextPosition = position + 2 + count * 12;
        if (nextPosition + 4 <= data.length) next = readU32(data, nextPosition, little);
        return exifIfd ? next : exifPointer;
    }

    private static String exifFieldName(int tag, boolean exifIfd) {
        if (!exifIfd) {
            if (tag == 0x010e) return "ImageDescription";
            if (tag == 0x010f) return "Make";
            if (tag == 0x0110) return "Model";
            if (tag == 0x0131) return "Software";
            if (tag == 0x013b) return "Artist";
            if (tag == 0x8298) return "Copyright";
            if (tag == 0x9c9c) return "XPComment";
            if (tag == 0x9c9e) return "XPTitle";
            if (tag == 0x9c9f) return "XPSubject";
        } else {
            if (tag == 0x9286) return "UserComment";
        }
        return null;
    }

    private static int exifTypeSize(int type) {
        if (type == 1 || type == 2 || type == 6 || type == 7 || type == 8) return 1;
        if (type == 3 || type == 9) return 2;
        if (type == 4 || type == 10 || type == 11 || type == 12) return 4;
        if (type == 5) return 8;
        return 0;
    }

    private static String decodeUserComment(byte[] data, int start, int length) {
        if (length == 0) return "";
        String marker = new String(data, start, Math.min(8, length), StandardCharsets.ISO_8859_1);
        if (marker.startsWith("ASCII")) return stripNul(decodeUtf8Loose(data, start + 8, length - 8));
        if (marker.startsWith("UNICODE")) return decodeUtf16Loose(data, start + 8, length - 8, false);
        if (marker.startsWith("JIS")) {
            try { return stripNul(new String(data, start + 8, length - 8, "ISO-2022-JP")); }
            catch (java.io.UnsupportedEncodingException ignored) { return ""; }
        }
        return stripNul(decodeUtf8Loose(data, start, length));
    }

    private static String decodeExifText(byte[] data, int start, int length) {
        int end = start + length;
        while (end > start && data[end - 1] == 0) end--;
        return decodeUtf8Loose(data, start, end - start);
    }

    private static String decodeUtf16Loose(byte[] data, int start, int length, boolean little) {
        if (length <= 0) return "";
        if (length >= 2) {
            if ((data[start] & 255) == 0xff && (data[start + 1] & 255) == 0xfe) {
                little = true;
                start += 2;
                length -= 2;
            } else if ((data[start] & 255) == 0xfe && (data[start + 1] & 255) == 0xff) {
                little = false;
                start += 2;
                length -= 2;
            }
        }
        if ((length & 1) != 0) length--;
        if (length <= 0) return "";
        return stripNul(new String(data, start, length,
                little ? StandardCharsets.UTF_16LE : StandardCharsets.UTF_16BE));
    }

    private static String decodeUtf8Loose(byte[] data, int start, int length) {
        if (length <= 0) return "";
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data, start, length)).toString();
        } catch (CharacterCodingException failure) {
            return stripNul(new String(data, start, length, StandardCharsets.ISO_8859_1));
        }
    }

    private static String stripNul(String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '\0') end--;
        return value.substring(0, end);
    }

    private static int readU16(byte[] data, int offset, boolean little) {
        if (little) return (data[offset] & 255) | (data[offset + 1] & 255) << 8;
        return (data[offset] & 255) << 8 | (data[offset + 1] & 255);
    }

    private static long readU32(byte[] data, int offset, boolean little) {
        if (little) {
            return (data[offset] & 255L) | (data[offset + 1] & 255L) << 8
                    | (data[offset + 2] & 255L) << 16 | (data[offset + 3] & 255L) << 24;
        }
        return (data[offset] & 255L) << 24 | (data[offset + 1] & 255L) << 16
                | (data[offset + 2] & 255L) << 8 | (data[offset + 3] & 255L);
    }

    private static int readU24(byte[] data, int offset) {
        return (data[offset] & 255) | (data[offset + 1] & 255) << 8 | (data[offset + 2] & 255) << 16;
    }

    private static long readU32(DataInputStream input, boolean little) throws IOException {
        int value = input.readInt();
        return little ? Integer.toUnsignedLong(Integer.reverseBytes(value)) : Integer.toUnsignedLong(value);
    }

    private Map<String, String> readAlpha(ImageInput source, ImageData png) throws IOException {
        long pixels = (long)png.width * png.height;
        if (pixels > MAX_PIXELS || png.width > 16384 || png.height > 16384) {
            throw new IOException("隐藏信息读取最多支持 800 万像素的原图。");
        }
        if (png.depth == 16) throw new IOException("未找到提示词文本；暂不支持 16 位 PNG 的隐藏信息。");
        if (pixels * 4 > Runtime.getRuntime().maxMemory() / 3) {
            throw new IOException("原图较大，当前手机内存不足以读取隐藏信息。");
        }
        Bitmap bitmap = null;
        try (InputStream input = source.open()) {
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
                throw new IOException("无法解码原图中的隐藏信息。");
            }
            if (!bitmap.hasAlpha()) return null;
            final Bitmap decoded = bitmap;
            final int[] column = new int[png.height];
            AlphaPixels pixelsByColumn = new AlphaPixels() {
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
            String raw = extractAlpha(png.width, png.height, pixelsByColumn);
            if (raw == null) return null;
            if (!safeDepth(raw)) throw new IOException("图片隐藏信息的数据层次异常，无法读取。");
            JSONObject root;
            try { root = new JSONObject(raw); }
            catch (org.json.JSONException failure) { throw new IOException("图片的隐藏信息不是有效的 JSON 内容。"); }
            Map<String, String> fields = new LinkedHashMap<>();
            int metadataBytes = 0;
            Iterator<String> keys = root.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = root.opt(key);
                if (value == null || value == JSONObject.NULL) continue;
                String text = value instanceof String ? (String)value : value.toString();
                int bytes = text.getBytes(StandardCharsets.UTF_8).length;
                if (bytes > MAX_FIELD) {
                    throw new IOException("隐藏信息中的单个文本字段超过 1 MB，暂时无法读取。");
                }
                metadataBytes += bytes;
                if (metadataBytes > MAX_METADATA) throw new IOException("图片隐藏信息超过 2 MB，暂时无法读取。");
                putField(fields, key, text);
            }
            return fields;
        } catch (OutOfMemoryError tooLarge) {
            throw new IOException("当前手机内存不足，请关闭其他应用后再读取这张原图。");
        } finally {
            if (bitmap != null) bitmap.recycle();
            activeStream = null;
        }
    }

    private String readPreview(ImageInput source, ImageData image) {
        if (destroyed || image.width <= 0 || image.height <= 0) return null;
        Bitmap bitmap = null;
        try (InputStream input = source.open()) {
            if (input == null) return null;
            activeStream = input;
            BitmapFactory.Options options = new BitmapFactory.Options();
            int longest = Math.max(image.width, image.height);
            options.inSampleSize = 1;
            while (longest / options.inSampleSize > 512) options.inSampleSize *= 2;
            options.inScaled = false;
            bitmap = BitmapFactory.decodeStream(new LimitedInput(input), null, options);
            if (bitmap == null) return null;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 80, bytes) || bytes.size() > 192 * 1024) return null;
            return "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        } catch (Exception | OutOfMemoryError failure) {
            return null;
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
        return summarize(fields, "PNG text", "");
    }

    private static JSONObject summarize(Map<String, String> fields, String metadataType, String missingReason)
            throws org.json.JSONException {
        List<ParameterCandidate> candidates = new ArrayList<>();
        for (Map.Entry<String, String> entry : fields.entrySet()) {
            String raw = entry.getValue();
            if (!looksLikeJsonObject(raw) || !safeDepth(raw)) continue;
            try {
                JSONObject object = flattenParameters(new JSONObject(raw), 0);
                if (hasPromptSignals(object) || sourcePriority(entry.getKey()) > 0) {
                    candidates.add(new ParameterCandidate(entry.getKey(), raw, object));
                }
            } catch (org.json.JSONException ignored) {
                // A non-JSON comment is still exposed as rawComment/plain text below.
            }
        }
        Collections.sort(candidates, new Comparator<ParameterCandidate>() {
            public int compare(ParameterCandidate left, ParameterCandidate right) {
                return Integer.compare(left.score, right.score);
            }
        });
        ParameterCandidate best = null;
        JSONObject parameters = null;
        for (ParameterCandidate candidate : candidates) {
            if (best == null || candidate.score >= best.score) best = candidate;
            if (parameters == null) parameters = new JSONObject();
            deepMerge(parameters, candidate.object);
        }
        JSONObject direct = directParameters(fields);
        if (direct.length() > 0) {
            if (parameters == null) parameters = new JSONObject();
            deepMerge(parameters, direct);
        }

        JSONObject positive = objectValue(parameters, "v4_prompt");
        JSONObject negative = objectValue(parameters, "v4_negative_prompt");
        String rawComment = best == null ? firstPlainField(fields,
                "Comment", "UserComment", "EXIF:UserComment", "COM", "JPEG:COM") : best.raw;
        String prompt = first(string(parameters, "prompt"), v4CaptionText(positive), string(positive, "base_caption"),
                firstPlainField(fields, "Description", "ImageDescription", "Prompt"));
        String negativePrompt = first(string(parameters, "uc"), string(parameters, "negative_prompt"),
                v4CaptionText(negative), string(negative, "base_caption"));
        JSONObject actual = objectValue(parameters, "actual_prompts");
        JSONObject actualPositive = objectValue(actual, "prompt");
        JSONObject actualNegative = objectValue(actual, "negative_prompt");
        JSONArray characters = characterCaptions(positive);
        JSONArray negativeCharacters = characterCaptions(negative);
        String model = first(string(parameters, "model"), firstPlainField(fields,
                "Source", "Software", "Make", "Model"));
        boolean found = !prompt.isEmpty() || !negativePrompt.isEmpty()
                || characters.length() > 0 || negativeCharacters.length() > 0;

        JSONObject result = new JSONObject();
        result.put("found", found);
        result.put("prompt", prompt);
        result.put("negativePrompt", negativePrompt);
        result.put("actualPrompt", first(string(actual, "prompt"), v4CaptionText(actualPositive), string(actualPositive, "base_caption")));
        result.put("actualNegativePrompt", first(string(actual, "negative_prompt"), v4CaptionText(actualNegative), string(actualNegative, "base_caption")));
        result.put("actualCharacters", characterCaptions(actualPositive));
        result.put("actualNegativeCharacters", characterCaptions(actualNegative));
        result.put("model", model);
        result.put("rawComment", rawComment);
        result.put("parameters", parameters == null ? JSONObject.NULL : parameters);
        result.put("characters", characters);
        result.put("negativeCharacters", negativeCharacters);
        result.put("v4Prompt", positive == null ? JSONObject.NULL : positive);
        result.put("v4NegativePrompt", negative == null ? JSONObject.NULL : negative);
        result.put("metadata", new JSONObject(fields));
        result.put("metadataType", metadataType == null || metadataType.isEmpty() ? "image metadata" : metadataType);
        if (found) {
            result.put("message", "已读取图片内的文本信息。");
        } else {
            String reason = missingReason == null || missingReason.isEmpty()
                    ? "未找到可读取的提示词。图片可能没有保存提示词，或已被截图、压缩、转存清除。"
                    : missingReason;
            result.put("message", reason);
            result.put("missingReason", reason);
        }
        return result;
    }

    private static JSONObject directParameters(Map<String, String> fields) throws org.json.JSONException {
        JSONObject result = new JSONObject();
        for (Map.Entry<String, String> entry : fields.entrySet()) {
            String normalized = parameterName(entry.getKey());
            if (!Arrays.asList("prompt", "uc", "negative_prompt", "model", "v4_prompt",
                    "v4_negative_prompt", "sampler", "steps", "seed", "width", "height", "scale",
                    "cfg_rescale", "noise_schedule", "strength", "noise", "uncond_scale", "sm", "sm_dyn",
                    "qualityToggle", "dynamic_thresholding", "ucPreset", "n_samples", "denoise_strength").contains(normalized)) {
                continue;
            }
            String value = entry.getValue();
            if (("v4_prompt".equals(normalized) || "v4_negative_prompt".equals(normalized))
                    && looksLikeJsonObject(value) && safeDepth(value)) {
                result.put(normalized, new JSONObject(value));
            } else if (!looksLikeJsonObject(value)) {
                result.put(normalized, value);
            }
        }
        return result;
    }

    private static JSONObject flattenParameters(JSONObject source, int depth) throws org.json.JSONException {
        JSONObject result = new JSONObject();
        List<String> flattened = new ArrayList<>();
        JSONObject comment = null;
        Iterator<String> names = source.keys();
        while (names.hasNext()) {
            String key = names.next();
            String compact = compactKey(key);
            if (depth >= 32 || !PARAMETER_WRAPPERS.contains(compact)) continue;
            JSONObject nested = objectValue(source, key);
            if (nested == null) continue;
            flattened.add(key);
            JSONObject fields = flattenParameters(nested, depth + 1);
            if ("comment".equals(compact)) comment = fields;
            else deepMerge(result, fields);
        }
        names = source.keys();
        while (names.hasNext()) {
            String key = names.next();
            if (flattened.contains(key)) continue;
            String name = parameterName(key);
            // When both spellings exist, the canonical key takes priority.
            if (!key.equals(name) && source.has(name)) continue;
            result.put(name, source.get(key));
        }
        if (comment != null) deepMerge(result, comment);
        return result;
    }

    private static String compactKey(String key) {
        return key.toLowerCase(Locale.ROOT).replace("_", "").replace("-", "").replace(" ", "");
    }

    private static String parameterName(String key) {
        switch (compactKey(key)) {
            case "sampler": case "samplername": case "samplingmethod": return "sampler";
            case "steps": case "nsteps": case "stepcount": case "numinferencesteps": case "samplingsteps": return "steps";
            case "seed": case "randomseed": return "seed";
            case "scale": case "cfgscale": case "guidancescale": return "scale";
            case "cfgrescale": return "cfg_rescale";
            case "noiseschedule": return "noise_schedule";
            case "negativeprompt": return "negative_prompt";
            case "v4prompt": return "v4_prompt";
            case "v4negativeprompt": return "v4_negative_prompt";
            case "actualprompts": return "actual_prompts";
            case "qualitytoggle": return "qualityToggle";
            case "ucpreset": return "ucPreset";
            case "dynamicthresholding": return "dynamic_thresholding";
            case "uncondscale": return "uncond_scale";
            case "nsamples": return "n_samples";
            case "denoisestrength": return "denoise_strength";
            case "smdyn": return "sm_dyn";
            case "prompt": case "uc": case "model": case "width": case "height": case "noise":
            case "strength": case "sm": return compactKey(key);
            default: return key;
        }
    }

    private static final class ParameterCandidate {
        final String raw;
        final JSONObject object;
        final int score;
        ParameterCandidate(String key, String raw, JSONObject object) {
            this.raw = raw;
            this.object = object;
            this.score = sourcePriority(key) + semanticScore(object);
        }
    }

    private static int sourcePriority(String key) {
        if (key == null) return 0;
        if ("Comment".equalsIgnoreCase(key)) return 100;
        if (Arrays.asList("parameters", "generation", "settings", "generationparams",
                "generationparameters", "generationsettings").contains(compactKey(key))) return 90;
        if ("UserComment".equalsIgnoreCase(key) || "EXIF:UserComment".equalsIgnoreCase(key)) return 80;
        if ("COM".equalsIgnoreCase(key) || key.startsWith("COM.")) return 70;
        if ("Description".equalsIgnoreCase(key) || "ImageDescription".equalsIgnoreCase(key)) return 20;
        return 0;
    }

    private static int semanticScore(JSONObject object) {
        JSONObject positive = objectValue(object, "v4_prompt");
        JSONObject negative = objectValue(object, "v4_negative_prompt");
        int score = 0;
        if (!v4CaptionText(positive).isEmpty()) score += 1000;
        score += Math.min(1000, characterCaptions(positive).length() * 200);
        if (!v4CaptionText(negative).isEmpty()) score += 300;
        score += Math.min(500, characterCaptions(negative).length() * 100);
        if (!string(object, "prompt").isEmpty()) score += 100;
        if (!string(object, "uc").isEmpty() || !string(object, "negative_prompt").isEmpty()) score += 50;
        return score;
    }

    private static boolean hasPromptSignals(JSONObject object) {
        return object.has("prompt") || object.has("uc") || object.has("negative_prompt")
                || object.has("v4_prompt") || object.has("v4_negative_prompt");
    }

    private static JSONObject objectValue(JSONObject object, String key) {
        Object value = object == null ? null : object.opt(key);
        if (value instanceof JSONObject) return (JSONObject)value;
        if (value instanceof String && safeDepth((String)value)) {
            try { return new JSONObject((String)value); }
            catch (org.json.JSONException ignored) { return null; }
        }
        return null;
    }

    private static String v4CaptionText(JSONObject v4) {
        Object caption = v4 == null ? null : v4.opt("caption");
        if (caption instanceof String) return (String)caption;
        if (caption instanceof JSONObject) return string((JSONObject)caption, "base_caption");
        return "";
    }

    private static JSONArray characterCaptions(JSONObject v4) {
        if (v4 == null) return new JSONArray();
        JSONObject caption = v4.optJSONObject("caption");
        JSONArray characters = (caption == null ? v4 : caption).optJSONArray("char_captions");
        return characters == null ? new JSONArray() : characters;
    }

    private static void deepMerge(JSONObject target, JSONObject source) throws org.json.JSONException {
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object incoming = source.opt(key);
            if (incoming == null || incoming == JSONObject.NULL) {
                if (incoming == JSONObject.NULL && !target.has(key)) target.put(key, incoming);
                continue;
            }
            Object current = target.opt(key);
            if (current instanceof JSONObject && incoming instanceof JSONObject) {
                deepMerge((JSONObject)current, (JSONObject)incoming);
            } else if (current instanceof JSONArray && incoming instanceof JSONArray
                    && ((JSONArray)incoming).length() < ((JSONArray)current).length()) {
                continue;
            } else if (current instanceof String && !((String)current).isEmpty()
                    && incoming instanceof String && ((String)incoming).isEmpty()) {
                continue;
            } else {
                target.put(key, incoming);
            }
        }
    }

    private static Map<String, String> mergeFields(Map<String, String> visible, Map<String, String> hidden) {
        Map<String, String> merged = new LinkedHashMap<>(visible);
        for (Map.Entry<String, String> entry : hidden.entrySet()) {
            String current = merged.get(entry.getKey());
            if (current == null || current.isEmpty()) {
                merged.put(entry.getKey(), entry.getValue());
                continue;
            }
            String incoming = entry.getValue();
            if (looksLikeJsonObject(current) && looksLikeJsonObject(incoming)
                    && safeDepth(current) && safeDepth(incoming)) {
                try {
                    JSONObject object = new JSONObject(current);
                    deepMerge(object, new JSONObject(incoming));
                    merged.put(entry.getKey(), object.toString());
                    continue;
                } catch (org.json.JSONException ignored) {
                    // Fall through to the richer literal value.
                }
            }
            if (fieldValueScore(incoming) >= fieldValueScore(current)) {
                merged.put(entry.getKey(), incoming);
            }
        }
        return merged;
    }

    private static int fieldValueScore(String value) {
        if (value == null || value.isEmpty()) return 0;
        if (looksLikeJsonObject(value) && safeDepth(value)) {
            try { return 1000 + semanticScore(new JSONObject(value)) + value.length(); }
            catch (org.json.JSONException ignored) { /* Plain text fallback. */ }
        }
        return value.length();
    }

    private static boolean looksLikeJsonObject(String value) {
        if (value == null) return false;
        int start = 0;
        while (start < value.length() && Character.isWhitespace(value.charAt(start))) start++;
        return start < value.length() && value.charAt(start) == '{';
    }

    private static String firstPlainField(Map<String, String> fields, String... names) {
        for (String name : names) {
            for (Map.Entry<String, String> entry : fields.entrySet()) {
                if ((entry.getKey().equalsIgnoreCase(name)
                        || entry.getKey().toLowerCase(java.util.Locale.ROOT)
                        .startsWith(name.toLowerCase(java.util.Locale.ROOT) + "."))
                        && !looksLikeJsonObject(entry.getValue())) {
                    return entry.getValue();
                }
            }
        }
        return "";
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
