package app.nai.pocketlibrary;

import java.io.DataInputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Reads selected byte ranges from the published community ZIP. */
final class SharedStyleRemote implements SharedStyleZip.Source {
    private static final Pattern ARCHIVE = Pattern.compile("https://huggingface\\.co/datasets/okawaritsuika/"
            + "nai-shared-styles/resolve/([a-f0-9]{40})/NAImakeArtistGroup_shared_images_[0-9]{8}_webp\\.zip");
    private static final int MAX_RANGE = 12 * 1024 * 1024;
    private static final long MAX_ARCHIVE = 2L * 1024 * 1024 * 1024;
    private static final int MAX_REDIRECTS = 4;
    private static final int TIMEOUT_MILLIS = 12000;

    final String sourceUrl;
    final String manifestSha;
    private final String commit;
    private final long bytes;

    private SharedStyleRemote(String sourceUrl, String commit, long bytes, String manifestSha) {
        this.sourceUrl = sourceUrl;
        this.commit = commit;
        this.bytes = bytes;
        this.manifestSha = manifestSha;
    }

    static SharedStyleRemote open(String sourceUrl, long bytes, String manifestSha) throws IOException {
        Matcher archive = ARCHIVE.matcher(sourceUrl == null ? "" : sourceUrl);
        if (!archive.matches() || bytes < 22 || bytes > MAX_ARCHIVE
                || manifestSha == null || !manifestSha.matches("[a-f0-9]{64}")) {
            throw new IOException("线上社区图包配置无效。");
        }
        return new SharedStyleRemote(sourceUrl, archive.group(1), bytes, manifestSha);
    }

    @Override
    public long size() {
        return bytes;
    }

    @Override
    public ByteBuffer read(long offset, int length) throws IOException {
        if (offset < 0 || length < 0 || length > MAX_RANGE || offset > bytes - length) {
            throw new IOException("线上社区图包读取范围无效。");
        }
        if (length == 0) return ByteBuffer.allocate(0);
        long last = offset + length - 1;
        String range = "bytes=" + offset + "-" + last;
        String contentRange = "bytes " + offset + "-" + last + "/" + bytes;
        URL url = new URL(sourceUrl);
        for (int redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            if (!KoreanLibrary.allowedUrl(url) || (redirects > 0 && !"us.aws.cdn.hf.co".equals(url.getHost()))) {
                throw new IOException("线上社区图包返回了不受支持的下载地址。");
            }
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(TIMEOUT_MILLIS);
            connection.setReadTimeout(TIMEOUT_MILLIS);
            connection.setRequestProperty("Range", range);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", "NAI-Pocket-Library");
            try {
                int status = connection.getResponseCode();
                if (redirects == 0) verifyOrigin(connection);
                if (isRedirect(status)) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirects == MAX_REDIRECTS) {
                        throw new IOException("线上社区图包的下载地址无效。");
                    }
                    url = new URL(url, location);
                    continue;
                }
                // Do not open the stream if the server offers the whole archive.
                if (status != 206 || !contentRange.equals(connection.getHeaderField("Content-Range"))) {
                    throw new IOException("服务器未返回指定的图包片段。");
                }
                String encoding = connection.getHeaderField("Content-Encoding");
                long responseLength = connection.getContentLengthLong();
                if ((encoding != null && !"identity".equalsIgnoreCase(encoding))
                        || (responseLength != -1 && responseLength != length)) {
                    throw new IOException("服务器返回的图包片段长度或格式不符。");
                }
                byte[] result = new byte[length];
                try (DataInputStream input = new DataInputStream(connection.getInputStream())) {
                    input.readFully(result);
                    if (responseLength == -1 && input.read() != -1) {
                        throw new IOException("服务器返回的图包片段过长。");
                    }
                }
                return ByteBuffer.wrap(result);
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("线上社区图包的下载地址无效。");
    }

    private void verifyOrigin(HttpURLConnection connection) throws IOException {
        String linkedSize = connection.getHeaderField("X-Linked-Size");
        if (!commit.equals(connection.getHeaderField("X-Repo-Commit"))
                || (linkedSize != null && !Long.toString(bytes).equals(linkedSize))) {
            throw new IOException("原站图包版本与目录配置不符。");
        }
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }
}
