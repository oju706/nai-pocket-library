package app.nai.pocketlibrary;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Converts an ordinary image ZIP into a compact on-disk image store and byte index. */
final class ImagePackZip {
    static final long MAX_ZIP_BYTES = 256L * 1024 * 1024;
    private static final int MAX_ENTRIES = 10000;

    static final class Span {
        final long offset;
        final int length;

        Span(long offset, int length) {
            this.offset = offset;
            this.length = length;
        }
    }

    static final class Index {
        final String id;
        final Map<String, List<Span>> rows;

        Index(String id, Map<String, List<Span>> rows) {
            this.id = id;
            this.rows = rows;
        }
    }

    static Index read(InputStream source, OutputStream target, int maxImageBytes, long maxOutputBytes) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }

        Map<String, List<Span>> rows = new LinkedHashMap<>();
        long offset = 0;
        long expanded = 0;
        int entries = 0;
        byte[] buffer = new byte[32768];
        DigestOutputStream images = new DigestOutputStream(target, digest);
        try (ZipInputStream zip = new ZipInputStream(new BoundedInput(source))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (++entries > MAX_ENTRIES) throw new IOException("ZIP 中的项目超过 10,000 个，请拆成多个图包。");
                String[] path = safePath(entry.getName());
                String filename = path[path.length - 1];
                String type = entry.isDirectory() ? null : declaredType(filename);
                String tag = type == null ? null : artistTag(path);
                byte[] header = new byte[12];
                int length = 0;
                for (int read; (read = zip.read(buffer)) != -1;) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("图包导入已停止。");
                    expanded += read;
                    if (expanded > maxOutputBytes) throw new IOException("ZIP 解压后太大或手机空间不足，请拆成小包。");
                    if (tag == null) continue;
                    if (read > maxImageBytes - length) throw new IOException("单张图超过 12 MB，请缩小后重新打包。");
                    if (length < header.length) {
                        System.arraycopy(buffer, 0, header, length, Math.min(read, header.length - length));
                    }
                    images.write(buffer, 0, read);
                    length += read;
                }
                if (tag != null) {
                    if (length < header.length || !type.equals(NaxLibrary.imageType(header))) {
                        throw new IOException("ZIP 内有图片格式与文件名不符或文件损坏。");
                    }
                    rows.computeIfAbsent(tag, ignored -> new ArrayList<>()).add(new Span(offset, length));
                    offset += length;
                }
                zip.closeEntry();
            }
        }
        if (rows.isEmpty()) throw new IOException("ZIP 中没有 JPEG、PNG 或 WebP 图片。");

        // Include the complete mapping in the ID. Re-importing the same pictures keeps old references valid.
        ByteBuffer number = ByteBuffer.allocate(8);
        hashNumber(digest, number, offset);
        for (Map.Entry<String, List<Span>> row : rows.entrySet()) {
            byte[] tag = row.getKey().getBytes(StandardCharsets.UTF_8);
            hashNumber(digest, number, tag.length);
            digest.update(tag);
            hashNumber(digest, number, row.getValue().size());
            for (Span span : row.getValue()) {
                hashNumber(digest, number, span.offset);
                hashNumber(digest, number, span.length);
            }
        }
        return new Index(UUID.nameUUIDFromBytes(digest.digest()).toString(), rows);
    }

    private static void hashNumber(MessageDigest digest, ByteBuffer buffer, long number) {
        buffer.clear();
        buffer.putLong(number);
        digest.update(buffer.array());
    }

    private static String[] safePath(String name) throws IOException {
        String path = name.replace('\\', '/');
        if (path.length() > 1024 || path.startsWith("/") || path.indexOf(':') >= 0) {
            throw new IOException("ZIP 中含有不安全的文件路径。");
        }
        if (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        String[] parts = path.split("/", -1);
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.chars().anyMatch(Character::isISOControl)) {
                throw new IOException("ZIP 中含有不安全的文件路径。");
            }
        }
        return parts;
    }

    private static String artistTag(String[] path) throws IOException {
        String filename = path[path.length - 1];
        String tag = (path.length == 1 ? filename.substring(0, filename.lastIndexOf('.')) : path[path.length - 2]).trim();
        if (tag.isEmpty() || tag.length() > 200) throw new IOException("请用非空的画师标签作为图片文件名或文件夹名。");
        return tag;
    }

    private static String declaredType(String filename) {
        String name = filename.toLowerCase(Locale.ROOT);
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".webp")) return "image/webp";
        return null;
    }

    private static final class BoundedInput extends FilterInputStream {
        private long remaining = MAX_ZIP_BYTES;

        BoundedInput(InputStream input) {
            super(input);
        }

        @Override public int read() throws IOException {
            if (remaining == 0) throw tooLarge();
            int value = in.read();
            if (value != -1) remaining--;
            return value;
        }

        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (remaining == 0) throw tooLarge();
            int read = in.read(buffer, offset, (int) Math.min(length, remaining));
            if (read > 0) remaining -= read;
            return read;
        }

        private IOException tooLarge() {
            return new IOException("ZIP 文件超过 256 MB，请拆成多个图包。");
        }
    }

    private ImagePackZip() {}
}
