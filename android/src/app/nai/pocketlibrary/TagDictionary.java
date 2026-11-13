package app.nai.pocketlibrary;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

final class TagDictionary {
    static final String RELEASE_URL = "https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/"
            + "releases/download/v2026-11-01/tag.sqlite";
    static final String REPOSITORY = "https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table";
    static final String VERSION = "v2026-11-01";
    static final String SHA256 = "48523aaf9ac800e13a72c7d68ce78021e6d55c811891719ade0820c6c536b716";
    static final long EXPECTED_BYTES = 24829952L;

    private static final int LOOKUP_LIMIT = 200;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final long DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000L;
    private static final int MAX_REDIRECTS = 5;
    private static final long MAX_ROWS = 20000000L;
    private static final Set<String> RELEASE_ASSET_HOSTS = new HashSet<>(Arrays.asList(
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com"
    ));

    private final File directory;
    private final File database;
    private final File temporary;
    private final Object operation = new Object();
    private final AtomicBoolean installing = new AtomicBoolean();
    private String validatedTable;
    private long validatedLength = -1;
    private long validatedModified = -1;

    TagDictionary(Context context) {
        directory = new File(context.getFilesDir(), "tag-dictionary");
        database = new File(directory, "tag.sqlite");
        temporary = new File(directory, "tag.sqlite.download");
    }

    JSONObject status() throws IOException, JSONException {
        synchronized (operation) {
            if (!database.isFile()) return baseStatus(false);
            if (database.length() != EXPECTED_BYTES) {
                throw new IOException("中文标签词典文件不完整，请重新下载安装。");
            }
            databaseTable();
            return baseStatus(true);
        }
    }

    JSONObject install() throws IOException, JSONException {
        if (!installing.compareAndSet(false, true)) {
            throw new IOException("中文标签词典正在下载安装，请稍候。");
        }
        try {
            synchronized (operation) {
                if (database.isFile() && database.length() == EXPECTED_BYTES) {
                    try {
                        databaseTable();
                        return baseStatus(true);
                    } catch (IOException ignored) {
                        // A damaged local copy is replaced after a verified download.
                    }
                }
            }
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new IOException("无法创建中文标签词典目录。");
            }
            if (temporary.exists() && !temporary.delete()) {
                throw new IOException("无法清理上次未完成的词典下载。");
            }
            download(temporary);
            String table = validateDownload(temporary);
            synchronized (operation) {
                replaceAtomically(temporary, database);
                rememberValidation(database, table);
            }
            return baseStatus(true);
        } finally {
            if (temporary.exists()) temporary.delete();
            installing.set(false);
        }
    }

    JSONObject remove() throws IOException, JSONException {
        if (!installing.compareAndSet(false, true)) {
            throw new IOException("中文标签词典正在下载或卸载，请稍候。");
        }
        try {
            synchronized (operation) {
                if (database.exists() && !database.delete()) {
                    throw new IOException("无法删除中文标签词典，请重试。");
                }
                if (temporary.exists() && !temporary.delete()) {
                    throw new IOException("无法清理未完成的词典下载。");
                }
                forgetValidation();
                return baseStatus(false);
            }
        } finally {
            installing.set(false);
        }
    }

    JSONObject lookup(String raw) throws IOException, JSONException {
        JSONArray input = new JSONArray(raw == null ? "[]" : raw);
        if (input.length() > LOOKUP_LIMIT) {
            throw new IllegalArgumentException("单次词典查询最多 " + LOOKUP_LIMIT + " 个标签。");
        }
        LinkedHashSet<String> unique = new LinkedHashSet<>();
        for (int index = 0; index < input.length(); index++) {
            String name = input.optString(index, "").trim();
            if (name.isEmpty()) continue;
            if (name.length() > 512) throw new IllegalArgumentException("标签名称过长。");
            unique.add(name);
        }
        JSONObject result = new JSONObject();
        if (unique.isEmpty()) return result;

        synchronized (operation) {
            if (!database.isFile()) return result;
            if (database.length() != EXPECTED_BYTES) {
                throw new IOException("中文标签词典文件不完整，请重新安装。");
            }
            String table = databaseTable();
            List<String> names = new ArrayList<>(unique);
            StringBuilder sql = new StringBuilder("SELECT name, cn_name FROM ")
                    .append(table).append(" WHERE name IN (");
            for (int index = 0; index < names.size(); index++) {
                if (index > 0) sql.append(',');
                sql.append('?');
            }
            sql.append(')');
            SQLiteDatabase readable = openReadable(database);
            try (Cursor cursor = readable.rawQuery(sql.toString(), names.toArray(new String[0]))) {
                while (cursor.moveToNext()) {
                    String name = cursor.getString(0);
                    String chinese = cursor.isNull(1) ? "" : cursor.getString(1).trim();
                    if (!name.isEmpty() && !chinese.isEmpty()) result.put(name, chinese);
                }
            } finally {
                readable.close();
            }
        }
        return result;
    }

    private JSONObject baseStatus(boolean installed) throws JSONException {
        return new JSONObject()
                .put("installed", installed)
                .put("bytes", database.isFile() ? database.length() : 0L)
                .put("expectedBytes", EXPECTED_BYTES)
                .put("version", VERSION)
                .put("sha256", SHA256)
                .put("source", RELEASE_URL)
                .put("repository", REPOSITORY)
                .put("license", "MIT");
    }

    private void download(File destination) throws IOException {
        URL current = new URL(RELEASE_URL);
        long deadline = System.currentTimeMillis() + DOWNLOAD_TIMEOUT_MS;
        if (!RELEASE_URL.equals(current.toExternalForm())) {
            throw new IOException("中文标签词典下载地址无效。");
        }
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("词典下载已取消。");
            if (System.currentTimeMillis() > deadline) {
                throw new IOException("中文标签词典下载超时，请重试。");
            }
            URLConnectionGuard.requireHttps(current);
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/octet-stream");
                connection.setRequestProperty("Accept-Encoding", "identity");
                connection.setRequestProperty("User-Agent", "NAI-Pocket-Library-Tag-Dictionary");
                int code = connection.getResponseCode();
                if (code >= 300 && code < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || location.trim().isEmpty()) {
                        throw new IOException("GitHub 下载重定向缺少目标地址。");
                    }
                    URL next = new URL(current, location.trim());
                    requireReleaseAsset(next);
                    current = next;
                    continue;
                }
                if (code != HttpURLConnection.HTTP_OK) {
                    throw new IOException("中文标签词典下载失败（HTTP " + code + "）。");
                }

                long declared = connection.getContentLengthLong();
                if (declared > EXPECTED_BYTES || (declared >= 0 && declared != EXPECTED_BYTES)) {
                    throw new IOException("中文标签词典下载大小与发行信息不一致。");
                }
                MessageDigest digest = sha256();
                long total = 0;
                try (InputStream input = connection.getInputStream();
                     FileOutputStream output = new FileOutputStream(destination)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new IOException("词典下载已取消。");
                        if (System.currentTimeMillis() > deadline) {
                            throw new IOException("中文标签词典下载超时，请重试。");
                        }
                        total += read;
                        if (total > EXPECTED_BYTES) {
                            throw new IOException("中文标签词典下载超过预期大小。");
                        }
                        digest.update(buffer, 0, read);
                        output.write(buffer, 0, read);
                    }
                    output.getFD().sync();
                }
                if (total != EXPECTED_BYTES) {
                    throw new IOException("中文标签词典下载不完整，请重试。");
                }
                String actual = hex(digest.digest());
                if (!SHA256.equals(actual)) {
                    throw new IOException("中文标签词典 SHA-256 校验失败，未安装。");
                }
                return;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("GitHub 下载重定向次数过多。");
    }

    private static void requireReleaseAsset(URL url) throws IOException {
        URLConnectionGuard.requireHttps(url);
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (!RELEASE_ASSET_HOSTS.contains(host)) {
            throw new IOException("GitHub 返回了非发布资产下载地址，已停止安装。");
        }
    }

    private static String validateDownload(File file) throws IOException {
        if (file.length() != EXPECTED_BYTES) {
            throw new IOException("中文标签词典大小校验失败，未安装。");
        }
        try (InputStream input = Files.newInputStream(file.toPath())) {
            MessageDigest digest = sha256();
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
            if (!SHA256.equals(hex(digest.digest()))) {
                throw new IOException("中文标签词典 SHA-256 校验失败，未安装。");
            }
        }
        return tableName(file);
    }

    private static String tableName(File file) throws IOException {
        SQLiteDatabase readable = openReadable(file);
        try {
            String table = null;
            try (Cursor cursor = readable.rawQuery(
                    "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
                    new String[]{"table", "tags"})) {
                if (cursor.moveToFirst()) table = "tags";
            }
            if (table == null) {
                try (Cursor cursor = readable.rawQuery(
                        "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
                        new String[]{"table", "tag"})) {
                    if (cursor.moveToFirst()) table = "tag";
                }
            }
            if (table == null) {
                throw new IOException("中文标签词典缺少 tags 表。");
            }
            validateColumns(readable, table);
            long rows;
            try (Cursor cursor = readable.rawQuery("SELECT COUNT(*) FROM " + table, null)) {
                if (!cursor.moveToFirst()) throw new IOException("无法读取中文标签词典行数。");
                rows = cursor.getLong(0);
            }
            if (rows <= 0) throw new IOException("中文标签词典没有可用词条。");
            if (rows > MAX_ROWS) throw new IOException("中文标签词典行数超出安全上限。");
            return table;
        } finally {
            readable.close();
        }
    }

    private String databaseTable() throws IOException {
        long length = database.length();
        long modified = database.lastModified();
        if (validatedTable != null && validatedLength == length && validatedModified == modified) {
            return validatedTable;
        }
        String table = tableName(database);
        rememberValidation(database, table);
        return table;
    }

    private void rememberValidation(File file, String table) {
        validatedTable = table;
        validatedLength = file.length();
        validatedModified = file.lastModified();
    }

    private void forgetValidation() {
        validatedTable = null;
        validatedLength = -1;
        validatedModified = -1;
    }

    private static void validateColumns(SQLiteDatabase readable, String table) throws IOException {
        Set<String> required = new HashSet<>(Arrays.asList("name", "category", "cn_name", "post_count"));
        String pragma = "tags".equals(table) ? "PRAGMA table_info(tags)" : "PRAGMA table_info(tag)";
        int namePrimaryKey = -1;
        try (Cursor cursor = readable.rawQuery(pragma, null)) {
            int nameColumn = cursor.getColumnIndexOrThrow("name");
            int primaryColumn = cursor.getColumnIndexOrThrow("pk");
            while (cursor.moveToNext()) {
                String column = cursor.getString(nameColumn).toLowerCase(Locale.ROOT);
                required.remove(column);
                if ("name".equals(column)) namePrimaryKey = cursor.getInt(primaryColumn);
            }
        }
        if (!required.isEmpty()) {
            throw new IOException("中文标签词典字段不完整，缺少 " + String.join(", ", required) + "。");
        }
        if (namePrimaryKey <= 0) {
            throw new IOException("中文标签词典的 name 字段不是主键。");
        }
    }

    private static SQLiteDatabase openReadable(File file) throws IOException {
        try {
            return SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY);
        } catch (RuntimeException failure) {
            throw new IOException("中文标签词典不是可读取的 SQLite 数据库。", failure);
        }
    }

    private static void replaceAtomically(File source, File target) throws IOException {
        try {
            Files.move(source.toPath(), target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException | UnsupportedOperationException failure) {
            throw new IOException("设备文件系统不支持词典原子替换，未安装。", failure);
        } catch (IOException failure) {
            throw new IOException("无法安装已校验的中文标签词典。", failure);
        }
    }

    private static MessageDigest sha256() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException failure) {
            throw new IOException("当前设备不支持 SHA-256 校验。", failure);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return output.toString();
    }

    private static final class URLConnectionGuard {
        private URLConnectionGuard() {}

        static void requireHttps(URL url) throws IOException {
            if (!"https".equalsIgnoreCase(url.getProtocol())
                    || url.getUserInfo() != null
                    || (url.getPort() != -1 && url.getPort() != 443)) {
                throw new IOException("中文标签词典只允许通过 HTTPS 下载。");
            }
        }
    }
}
