package app.nai.pocketlibrary;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PushbackInputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.function.IntConsumer;

import javax.net.ssl.HttpsURLConnection;

/** Opens a bounded, streaming GitHub ZIP download for the ZIP importer. */
final class RemotePackZip {
    private static final int TIMEOUT_MILLIS = 25000;
    private static final int MAX_REDIRECTS = 4;

    static Download open(String source, IntConsumer progress) throws IOException {
        URI current = validateInitialUrl(source);
        String name = fileName(current);
        HttpsURLConnection connection = null;
        try {
            for (int redirects = 0;; redirects++) {
                if (Thread.currentThread().isInterrupted()) throw new IOException("图包下载已停止。");
                connection = connect(current);
                int status = connection.getResponseCode();
                if (isRedirect(status)) {
                    if (redirects >= MAX_REDIRECTS) throw new IOException("GitHub 重定向次数过多。");
                    URI next = resolveRedirect(current, connection.getHeaderField("Location"));
                    connection.disconnect();
                    connection = null;
                    current = next;
                    continue;
                }
                if (status != HttpsURLConnection.HTTP_OK) {
                    throw new IOException("GitHub 返回 HTTP " + status + "。");
                }
                String encoding = connection.getContentEncoding();
                if (encoding != null && !"identity".equalsIgnoreCase(encoding.trim())) {
                    throw new IOException("GitHub 返回了不支持的压缩编码。");
                }
                long size = contentLength(connection);
                if (size > ImagePackZip.MAX_ZIP_BYTES) {
                    throw new IOException("ZIP 文件超过 256 MB，请拆成多个图包。");
                }

                BodyInput body = new BodyInput(connection.getInputStream(), size, progress);
                PushbackInputStream input = new PushbackInputStream(body, 4);
                try {
                    byte[] magic = new byte[4];
                    int count = 0;
                    while (count < magic.length) {
                        int read = input.read(magic, count, magic.length - count);
                        if (read < 0) break;
                        count += read;
                    }
                    if (count != magic.length || !isZipMagic(magic)) {
                        throw new IOException("下载内容不是有效的 ZIP 文件。");
                    }
                    input.unread(magic);
                    return new Download(connection, input, body, size, name);
                } catch (IOException | RuntimeException failure) {
                    try {
                        body.abort();
                    } catch (IOException closeFailure) {
                        failure.addSuppressed(closeFailure);
                    }
                    connection.disconnect();
                    connection = null;
                    throw failure;
                }
            }
        } catch (IOException | RuntimeException failure) {
            if (connection != null) connection.disconnect();
            throw failure;
        }
    }

    static URI validateInitialUrl(String source) throws IOException {
        URI uri = parse(source);
        validateSecureUrl(uri);
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IOException("图包 URL 不能包含查询参数或片段。");
        }
        String[] path = safePath(uri);
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if ("github.com".equals(host)) {
            if (path.length != 6 || !"releases".equals(path[2]) || !"download".equals(path[3])
                    || !isZipFile(path[5])) {
                throw invalidUrl();
            }
        } else if ("raw.githubusercontent.com".equals(host)) {
            if (path.length < 4 || !isZipFile(path[path.length - 1])) {
                throw invalidUrl();
            }
        } else {
            throw new IOException("仅支持 GitHub Release 或 raw.githubusercontent.com 的 ZIP 地址。");
        }
        return uri;
    }

    static URI resolveRedirect(URI current, String location) throws IOException {
        if (location == null || location.trim().isEmpty()) throw new IOException("GitHub 重定向缺少地址。");
        URI next;
        try {
            next = current.resolve(new URI(location.trim()));
        } catch (URISyntaxException | IllegalArgumentException failure) {
            throw new IOException("GitHub 返回了无效的重定向地址。", failure);
        }
        if (next.getRawFragment() != null) throw new IOException("GitHub 重定向地址不能包含片段。");
        validateSecureUrl(next);
        String[] path = safePath(next);
        if (path.length == 0) throw invalidUrl();
        String host = next.getHost().toLowerCase(Locale.ROOT);
        if ("release-assets.githubusercontent.com".equals(host)
                || "objects.githubusercontent.com".equals(host)) {
            return next;
        }
        if (next.getRawQuery() != null) throw new IOException("GitHub 重定向地址无效。");
        validateInitialUrl(next.toString());
        return next;
    }

    static final class Download implements AutoCloseable {
        private final HttpsURLConnection connection;
        private final InputStream input;
        private final BodyInput body;
        private final long size;
        private final String name;
        private boolean closed;

        Download(HttpsURLConnection connection, InputStream input, BodyInput body, long size, String name) {
            this.connection = connection;
            this.input = input;
            this.body = body;
            this.size = size;
            this.name = name;
        }

        InputStream input() {
            return new FilterInputStream(input) {
                @Override public void close() { /* Download owns the network connection. */ }
            };
        }

        void finish() throws IOException {
            byte[] buffer = new byte[32768];
            while (input.read(buffer) >= 0) { /* Verify the complete response before publishing the index. */ }
        }

        long size() {
            return size;
        }

        String name() {
            return name;
        }

        @Override public void close() throws IOException {
            if (closed) return;
            closed = true;
            try {
                body.abort();
            } finally {
                connection.disconnect();
            }
        }
    }

    private static HttpsURLConnection connect(URI uri) throws IOException {
        HttpsURLConnection connection;
        try {
            connection = (HttpsURLConnection) uri.toURL().openConnection();
        } catch (ClassCastException failure) {
            throw new IOException("图包地址必须使用 HTTPS。", failure);
        }
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(TIMEOUT_MILLIS);
        connection.setReadTimeout(TIMEOUT_MILLIS);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/zip, application/octet-stream");
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("User-Agent", "NAI-Pocket-Library");
        return connection;
    }

    private static URI parse(String value) throws IOException {
        if (value == null) throw invalidUrl();
        if (value.isEmpty() || value.length() > 8192 || !value.equals(value.trim())) throw invalidUrl();
        try {
            return new URI(value);
        } catch (URISyntaxException failure) {
            throw invalidUrl();
        }
    }

    private static void validateSecureUrl(URI uri) throws IOException {
        if (uri.isOpaque() || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getUserInfo() != null) {
            throw invalidUrl();
        }
        int port = uri.getPort();
        if (port != -1 && port != 443) throw new IOException("图包 URL 只允许 HTTPS 443 端口。");
    }

    private static String[] safePath(URI uri) throws IOException {
        String raw = uri.getRawPath();
        if (raw == null || raw.toLowerCase(Locale.ROOT).matches(".*%(2e|2f|5c|25).*")) throw invalidUrl();
        String path = uri.getPath();
        if (path == null || !path.startsWith("/") || path.length() > 4096 || path.contains("\\")) {
            throw invalidUrl();
        }
        String[] parts = path.substring(1).split("/", -1);
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)
                    || part.chars().anyMatch(Character::isISOControl)) {
                throw new IOException("图包 URL 含有不安全的路径。");
            }
            String folded = part.toLowerCase(Locale.ROOT);
            if (folded.contains("%2e") || folded.contains("%2f")
                    || folded.contains("%5c") || folded.contains("%25")) {
                throw new IOException("图包 URL 含有不安全的路径。");
            }
        }
        return parts;
    }

    private static boolean isZipFile(String name) {
        return name.length() > 4 && name.length() <= 255
                && name.toLowerCase(Locale.ROOT).endsWith(".zip");
    }

    private static String fileName(URI uri) throws IOException {
        String[] path = safePath(uri);
        String name = path[path.length - 1];
        if (!isZipFile(name)) throw invalidUrl();
        return name;
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303
                || status == 307 || status == 308;
    }

    private static boolean isZipMagic(byte[] magic) {
        return magic[0] == 'P' && magic[1] == 'K'
                && ((magic[2] == 3 && magic[3] == 4)
                || (magic[2] == 5 && magic[3] == 6));
    }

    private static long contentLength(HttpsURLConnection connection) throws IOException {
        String value = connection.getHeaderField("Content-Length");
        if (value == null) return -1;
        value = value.trim();
        if (value.isEmpty()) throw new IOException("GitHub 返回了无效的文件长度。");
        for (int i = 0; i < value.length(); i++) {
            if (value.charAt(i) < '0' || value.charAt(i) > '9') {
                throw new IOException("GitHub 返回了无效的文件长度。");
            }
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException failure) {
            throw new IOException("GitHub 返回了无效的文件长度。", failure);
        }
    }

    private static IOException invalidUrl() {
        return new IOException("请输入受支持的 GitHub ZIP 地址。");
    }

    private static final class BodyInput extends FilterInputStream {
        private final long expected;
        private final IntConsumer progress;
        private long received;
        private int lastProgress = Integer.MIN_VALUE;
        private boolean complete;
        private boolean closed;

        BodyInput(InputStream input, long expected, IntConsumer progress) {
            super(input);
            this.expected = expected;
            this.progress = progress;
            reportProgress();
        }

        @Override public int read() throws IOException {
            if (complete) return -1;
            byte[] one = new byte[1];
            int count = read(one, 0, 1);
            return count < 0 ? -1 : one[0] & 255;
        }

        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (buffer == null) throw new NullPointerException("buffer");
            if (offset < 0 || length < 0 || length > buffer.length - offset) {
                throw new IndexOutOfBoundsException();
            }
            if (length == 0) return 0;
            if (complete) return -1;
            if (Thread.currentThread().isInterrupted()) throw new IOException("图包下载已停止。");

            long remaining = ImagePackZip.MAX_ZIP_BYTES - received;
            int request = remaining >= length ? length : (int) remaining + 1;
            int count = in.read(buffer, offset, request);
            if (count < 0) {
                complete();
                return -1;
            }
            received += count;
            if (received > ImagePackZip.MAX_ZIP_BYTES) {
                throw new IOException("ZIP 文件超过 256 MB，请拆成多个图包。");
            }
            reportProgress();
            return count;
        }

        void abort() throws IOException {
            if (closed) return;
            closed = true;
            in.close();
        }

        private void complete() throws IOException {
            if (expected >= 0 && received != expected) {
                throw new IOException("GitHub 图包下载不完整。");
            }
            if (complete) return;
            complete = true;
            if (lastProgress != 90) {
                lastProgress = 90;
                progress.accept(90);
            }
        }

        private void reportProgress() {
            int value = -1;
            if (expected > 0) {
                value = (int) Math.min(90, received * 90 / expected);
            }
            if (value != lastProgress) {
                lastProgress = value;
                progress.accept(value);
            }
        }
    }

    private RemotePackZip() {}
}
