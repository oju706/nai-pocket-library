package app.nai.pocketlibrary;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/** Indexes a seekable ZIP and verifies individual entries without extracting the archive. */
final class SharedStyleZip {
    private static final int END_HEADER = 22;
    private static final int DIRECTORY_HEADER = 46;
    private static final int LOCAL_HEADER = 30;
    private static final int MAX_ENTRIES = 10000;
    private static final int MAX_DIRECTORY = 8 * 1024 * 1024;
    private static final int MAX_NAME = 1024;
    private static final long MAX_ARCHIVE = 2L * 1024 * 1024 * 1024;
    private static final int STORED = 0;
    private static final int DEFLATED = 8;
    private static final int SUPPORTED_FLAGS = 0x080e; // Deflate options, data descriptor and UTF-8.

    static final class Entry {
        final int bytes;
        private final String name;
        private final int compressed;
        private final long offset;
        private final int flags;
        private final int method;
        private final long crc;

        Entry(String name, int bytes, int compressed, long offset, int flags, int method, long crc) {
            this.name = name;
            this.bytes = bytes;
            this.compressed = compressed;
            this.offset = offset;
            this.flags = flags;
            this.method = method;
            this.crc = crc;
        }
    }

    private final long archiveLength;
    private final long directoryOffset;
    private final Map<String, Entry> entries;

    private SharedStyleZip(long archiveLength, long directoryOffset, Map<String, Entry> entries) {
        this.archiveLength = archiveLength;
        this.directoryOffset = directoryOffset;
        this.entries = entries;
    }

    static SharedStyleZip open(FileChannel file) throws IOException {
        return open(channel(file));
    }

    static SharedStyleZip open(Source source) throws IOException {
        long length = source.size();
        if (length < END_HEADER || length > MAX_ARCHIVE) {
            throw new IOException("社区图包大小无效。请选择手机本地保存的 ZIP，大小最多 2 GiB。");
        }
        int tailLength = (int) Math.min(length, END_HEADER + 65535);
        ByteBuffer tail = readAt(source, length - tailLength, tailLength);
        int end = endOffset(tail);
        int count = unsignedShort(tail, end + 10);
        long directoryLength = unsignedInt(tail, end + 12);
        long directoryOffset = unsignedInt(tail, end + 16);
        if (unsignedShort(tail, end + 4) != 0 || unsignedShort(tail, end + 6) != 0
                || unsignedShort(tail, end + 8) != count || count < 1 || count > MAX_ENTRIES
                || directoryLength < (long) count * DIRECTORY_HEADER || directoryLength > MAX_DIRECTORY
                || directoryOffset + directoryLength != length - tailLength + end) {
            throw invalidZip();
        }
        ByteBuffer directory = readAt(source, directoryOffset, (int) directoryLength);
        Map<String, Entry> entries = new HashMap<>();
        for (int i = 0; i < count; i++) {
            int offset = directory.position();
            if (directory.remaining() < DIRECTORY_HEADER || directory.getInt(offset) != 0x02014b50) {
                throw invalidZip();
            }
            int flags = unsignedShort(directory, offset + 8);
            int method = unsignedShort(directory, offset + 10);
            long crc = unsignedInt(directory, offset + 16);
            long compressed = unsignedInt(directory, offset + 20);
            long bytes = unsignedInt(directory, offset + 24);
            int nameLength = unsignedShort(directory, offset + 28);
            int next = DIRECTORY_HEADER + nameLength + unsignedShort(directory, offset + 30)
                    + unsignedShort(directory, offset + 32);
            long local = unsignedInt(directory, offset + 42);
            if ((flags & ~SUPPORTED_FLAGS) != 0 || (method != STORED && method != DEFLATED)
                    || (method == STORED && compressed != bytes) || bytes > Integer.MAX_VALUE
                    || local + LOCAL_HEADER + nameLength + compressed > directoryOffset
                    || nameLength < 1 || nameLength > MAX_NAME || next > directory.remaining()
                    || unsignedShort(directory, offset + 34) != 0) {
                throw invalidZip();
            }
            String name = new String(directory.array(), offset + DIRECTORY_HEADER, nameLength, StandardCharsets.US_ASCII);
            if (!safeName(name) || entries.containsKey(name)) throw invalidZip();
            entries.put(name, new Entry(name, (int) bytes, (int) compressed, local, flags, method, crc));
            directory.position(offset + next);
        }
        if (directory.hasRemaining()) throw invalidZip();
        return new SharedStyleZip(length, directoryOffset, entries);
    }

    Entry get(String name) {
        return entries.get(name);
    }

    int size() {
        return entries.size();
    }

    byte[] read(FileChannel file, Entry entry, int max) throws IOException {
        return read(channel(file), entry, max);
    }

    byte[] read(Source source, Entry entry, int max) throws IOException {
        if (entry == null || entries.get(entry.name) != entry || source.size() != archiveLength) {
            throw new IOException("图包文件已变化或缺少所需项目，请重新选择。");
        }
        if (entry.bytes > max || entry.compressed > (long) max + 65536) {
            throw new IOException("图包中的文件超过大小限制。");
        }
        ByteBuffer local = readAt(source, entry.offset, LOCAL_HEADER + entry.name.length());
        int nameLength = unsignedShort(local, 26);
        long dataOffset = entry.offset + LOCAL_HEADER + nameLength + unsignedShort(local, 28);
        if (local.getInt(0) != 0x04034b50 || unsignedShort(local, 6) != entry.flags
                || unsignedShort(local, 8) != entry.method || nameLength != entry.name.length()
                || dataOffset + entry.compressed > directoryOffset) {
            throw invalidZip();
        }
        String localName = new String(local.array(), LOCAL_HEADER, nameLength, StandardCharsets.US_ASCII);
        if (!entry.name.equals(localName)) throw invalidZip();
        byte[] compressed = readAt(source, dataOffset, entry.compressed).array();
        byte[] data = entry.method == STORED ? compressed : inflate(compressed, entry.bytes);
        CRC32 crc = new CRC32();
        crc.update(data);
        if (crc.getValue() != entry.crc) throw invalidZip();
        return data;
    }

    private static byte[] inflate(byte[] compressed, int length) throws IOException {
        Inflater inflater = new Inflater(true);
        try {
            inflater.setInput(compressed);
            byte[] data = new byte[length];
            int written = 0;
            while (written < data.length) {
                int count = inflater.inflate(data, written, data.length - written);
                if (count == 0) throw invalidZip();
                written += count;
            }
            // Finishing a block can require a final call after the last output byte.
            if ((!inflater.finished() && inflater.inflate(new byte[1]) != 0)
                    || !inflater.finished() || inflater.getRemaining() != 0) {
                throw invalidZip();
            }
            return data;
        } catch (DataFormatException malformed) {
            throw invalidZip();
        } finally {
            inflater.end();
        }
    }

    private static ByteBuffer readAt(Source source, long offset, int length) throws IOException {
        ByteBuffer bytes = source.read(offset, length);
        if (bytes.remaining() != length) throw invalidZip();
        return bytes.order(ByteOrder.LITTLE_ENDIAN);
    }

    static Source channel(FileChannel file) {
        return new Source() {
            public long size() throws IOException { return file.size(); }

            public ByteBuffer read(long offset, int length) throws IOException {
                ByteBuffer bytes = ByteBuffer.allocate(length);
                while (bytes.hasRemaining()) {
                    int count = file.read(bytes, offset + bytes.position());
                    if (count <= 0) throw invalidZip();
                }
                bytes.flip();
                return bytes;
            }
        };
    }

    interface Source {
        long size() throws IOException;
        ByteBuffer read(long offset, int length) throws IOException;
    }

    private static int endOffset(ByteBuffer tail) throws IOException {
        for (int i = tail.limit() - END_HEADER; i >= 0; i--) {
            if (tail.getInt(i) == 0x06054b50 && i + END_HEADER + unsignedShort(tail, i + 20) == tail.limit()) {
                return i;
            }
        }
        throw invalidZip();
    }

    private static boolean safeName(String name) {
        String path = name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
        for (String part : path.split("/", -1)) {
            if (part.equals(".") || part.equals("..") || !part.matches("[A-Za-z0-9_.-]{1,255}")) return false;
        }
        return true;
    }

    private static int unsignedShort(ByteBuffer bytes, int index) {
        return bytes.getShort(index) & 0xffff;
    }

    private static long unsignedInt(ByteBuffer bytes, int index) {
        return bytes.getInt(index) & 0xffffffffL;
    }

    private static IOException invalidZip() {
        return new IOException("ZIP 目录或文件校验失败，图包可能损坏或格式不受支持。");
    }
}
