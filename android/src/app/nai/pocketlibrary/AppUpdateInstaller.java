package app.nai.pocketlibrary;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;

/** Downloads verified updates into app storage. Installation is confirmed by Android. */
final class AppUpdateInstaller {
    private static final long MAX_APK = 128L * 1024 * 1024;
    private final Context context;

    AppUpdateInstaller(Context context) { this.context = context; }

    JSONObject ready() throws JSONException {
        PackageInfo apk = verifiedArchive(UpdateFileProvider.updateFile(context));
        JSONObject result = new JSONObject().put("available", apk != null).put("downloaded", apk != null);
        if (apk != null) result.put("latestVersion", apk.versionName).put("message", "新版已下载并通过签名校验。");
        return result;
    }

    JSONObject download(JSONObject offer) throws IOException, JSONException {
        if (!offer.optBoolean("available")) return offer;
        long size = offer.optLong("size");
        if (size <= 0 || size > MAX_APK) throw new IOException("新版安装包大小异常。");
        String expectedHash = offer.optString("sha256");
        File target = UpdateFileProvider.updateFile(context);
        File folder = target.getParentFile();
        if (folder == null || (!folder.isDirectory() && !folder.mkdirs())) throw new IOException("无法保存更新文件。");
        if (folder.getUsableSpace() < size) throw new IOException("手机空间不足，无法下载新版。");
        File temporary = File.createTempFile("update-", ".apk", folder);
        try {
            String hash = downloadBytes(new URL(offer.getString("downloadUrl")), size, temporary);
            if (!expectedHash.isEmpty() && !expectedHash.equalsIgnoreCase(hash)) throw new IOException("安装包校验值不符，请稍后重试。");
            PackageInfo apk = verifiedArchive(temporary);
            if (apk == null || offer.has("latestVersionCode") && apk.getLongVersionCode() != offer.optLong("latestVersionCode")) {
                throw new IOException("安装包签名、应用名称或版本不匹配。");
            }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            return offer.put("downloaded", true).put("message", "新版已下载并通过签名校验，可以安装。");
        } finally { if (temporary.exists()) temporary.delete(); }
    }

    Intent installIntent() throws IOException {
        if (verifiedArchive(UpdateFileProvider.updateFile(context)) == null) throw new IOException("请先下载并校验新版安装包。");
        if (!context.getPackageManager().canRequestPackageInstalls()) {
            return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
        }
        return new Intent(Intent.ACTION_VIEW).setDataAndType(UpdateFileProvider.updateUri(context), UpdateFileProvider.MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    private PackageInfo verifiedArchive(File apk) {
        if (!apk.isFile() || apk.length() < 1 || apk.length() > MAX_APK) return null;
        PackageManager manager = context.getPackageManager();
        try {
            PackageInfo current = manager.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            PackageInfo candidate = manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (candidate == null || !current.packageName.equals(candidate.packageName)
                    || candidate.getLongVersionCode() <= current.getLongVersionCode()
                    || current.signingInfo == null || candidate.signingInfo == null) return null;
            Signature[] original = current.signingInfo.getApkContentsSigners();
            Signature[] incoming = candidate.signingInfo.getApkContentsSigners();
            if (original == null || incoming == null || original.length == 0 || incoming.length != original.length) return null;
            return new HashSet<>(Arrays.asList(original)).equals(new HashSet<>(Arrays.asList(incoming))) ? candidate : null;
        } catch (PackageManager.NameNotFoundException | RuntimeException invalid) { return null; }
    }

    private static String downloadBytes(URL url, long expected, File output) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
        for (int redirects = 0; redirects <= 4; redirects++) {
            if (!allowedHost(url, redirects > 0)) throw new IOException("安装包下载地址无效。");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(25000);
            connection.setRequestProperty("Accept-Encoding", "identity");
            try {
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirects == 4) throw new IOException("安装包地址重定向失败。");
                    url = new URL(url, location);
                    continue;
                }
                if (status != 200) throw new IOException("GitHub 安装包暂时无法下载（HTTP " + status + "）。");
                long length = connection.getContentLengthLong();
                if (length >= 0 && length != expected) throw new IOException("安装包长度与发布清单不符。");
                String encoding = connection.getContentEncoding();
                if (encoding != null && !"identity".equalsIgnoreCase(encoding)) throw new IOException("安装包传输格式不符。");
                try (InputStream input = connection.getInputStream(); FileOutputStream file = new FileOutputStream(output)) {
                    byte[] buffer = new byte[32768];
                    long count = 0;
                    for (int read; (read = input.read(buffer)) >= 0;) {
                        if (Thread.currentThread().isInterrupted()) throw new IOException("更新下载已暂停。");
                        if (read > expected - count) throw new IOException("安装包超出预期长度。");
                        count += read;
                        digest.update(buffer, 0, read);
                        file.write(buffer, 0, read);
                    }
                    if (count != expected) throw new IOException("安装包下载不完整。");
                }
                StringBuilder hex = new StringBuilder(64);
                for (byte value : digest.digest()) {
                    hex.append(Character.forDigit((value >>> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
                }
                return hex.toString();
            } finally { connection.disconnect(); }
        }
        throw new IOException("安装包重定向次数过多。");
    }

    private static boolean allowedHost(URL url, boolean redirect) {
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null || url.getRef() != null
                || (url.getPort() != -1 && url.getPort() != 443)) return false;
        String host = url.getHost();
        return "github.com".equals(host) || "raw.githubusercontent.com".equals(host)
                || redirect && ("release-assets.githubusercontent.com".equals(host) || "objects.githubusercontent.com".equals(host));
    }
}
