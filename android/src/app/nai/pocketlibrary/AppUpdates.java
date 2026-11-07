package app.nai.pocketlibrary;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Checks a public GitHub Release. Downloads and installation stay with the system browser. */
final class AppUpdates {
    private static final String APK_NAME = "NAI-Pocket-Library.apk";
    private static final String DEFAULT_REPOSITORY = "oju706/nai-pocket-library";
    private final SharedPreferences preferences;
    private final String versionName;
    private final long versionCode;
    private long configurationRevision;
    private String checkedRepository = "";
    private String checkedRelease = "";
    private String checkedDownload = "";

    AppUpdates(Context context) {
        preferences = context.getSharedPreferences("app-updates", Context.MODE_PRIVATE);
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            versionName = info.versionName == null ? "" : info.versionName;
            versionCode = info.getLongVersionCode();
        } catch (PackageManager.NameNotFoundException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    synchronized JSONObject info() {
        try {
            return new JSONObject().put("versionName", versionName).put("versionCode", versionCode)
                    .put("repository", repository());
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    synchronized JSONObject setRepository(String input) {
        String repository = normalizeRepository(input);
        SharedPreferences.Editor editor = preferences.edit();
        if (repository.isEmpty()) editor.remove("repository");
        else editor.putString("repository", repository);
        editor.apply();
        configurationRevision++;
        checkedRepository = checkedRelease = checkedDownload = "";
        return info();
    }

    private String repository() {
        String repository = preferences.getString("repository", "");
        return repository.isEmpty() ? DEFAULT_REPOSITORY : repository;
    }

    static String normalizeRepository(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) return "";
        if (value.startsWith("https://")) {
            try {
                URI uri = new URI(value);
                if (!githubUri(uri) || uri.getRawPath() == null || uri.getRawPath().length() < 2) throw new IllegalArgumentException();
                value = uri.getRawPath().substring(1);
            } catch (URISyntaxException | IllegalArgumentException failure) {
                throw new IllegalArgumentException("请输入 GitHub 仓库地址，例如 https://github.com/作者/仓库名。");
            }
        }
        if (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        if (value.endsWith(".git")) value = value.substring(0, value.length() - 4);
        if (!value.matches("[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}")) {
            throw new IllegalArgumentException("请填写“作者/仓库名”或完整的 GitHub 仓库地址。");
        }
        String name = value.substring(value.indexOf('/') + 1);
        if (".".equals(name) || "..".equals(name)) throw new IllegalArgumentException("仓库名称无效。");
        return value.toLowerCase(Locale.ROOT);
    }

    JSONObject check() {
        String repo;
        long revision;
        JSONObject result;
        synchronized (this) {
            repo = repository();
            revision = configurationRevision;
            result = info();
            checkedRepository = checkedRelease = checkedDownload = "";
        }
        try {
            result.put("available", false).put("latestVersion", "").put("releaseUrl", "")
                    .put("downloadUrl", "").put("body", "").put("size", 0);
            if (repo.isEmpty()) return status(result, "unconfigured", "尚未配置发布仓库。发布后填入 GitHub 仓库地址即可检查应用更新。");
            HttpURLConnection connection = (HttpURLConnection) new URL("https://api.github.com/repos/" + repo + "/releases/latest").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            connection.setRequestProperty("User-Agent", "NAI-Pocket-Library/" + versionName);
            JSONObject release;
            try {
                int code = connection.getResponseCode();
                if (code == 404) return status(result, "unpublished", "暂未找到公开的正式版本。请确认仓库地址，或等待作者发布 Release。");
                if (code == 403 || code == 429) return status(result, "failed", "GitHub 暂时限制检查频率，请稍后重试。");
                if (code >= 300 && code < 400) return status(result, "unavailable", "仓库地址可能已变更，请在设置中填写新的仓库地址。");
                if (code != 200) throw new IOException("Unexpected response");
                if (connection.getContentLengthLong() > 512 * 1024) throw new IOException("Oversized release metadata");
                try (InputStream input = connection.getInputStream()) {
                    release = new JSONObject(new String(NaxLibrary.readBounded(input, 512 * 1024), StandardCharsets.UTF_8));
                }
            } finally {
                connection.disconnect();
            }
            if (release.optBoolean("draft", true) || release.optBoolean("prerelease", true)) {
                return status(result, "unpublished", "尚未找到可用的正式版本。");
            }
            String tag = release.optString("tag_name", "");
            String releaseUrl = release.optString("html_url", "");
            String text = release.optString("body", "");
            result.put("latestVersion", tag).put("body", text.substring(0, Math.min(text.length(), 4000)));
            Integer comparison = compareVersions(tag, versionName);
            if (comparison == null) return status(result, "unsupported_version", "发布版本号无法自动比较，请作者使用 v1.1 这样的数字版本号。");
            if (!validReleaseUrl(releaseUrl, repo, tag, false)) {
                return status(result, "unavailable", "发布链接与配置的仓库不一致，暂时无法打开。");
            }
            result.put("releaseUrl", releaseUrl);
            String downloadUrl = "";
            long size = 0;
            JSONArray assets = release.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject asset = assets.optJSONObject(i);
                    if (asset == null || !APK_NAME.equals(asset.optString("name")) || !"uploaded".equals(asset.optString("state"))) continue;
                    String candidate = asset.optString("browser_download_url", "");
                    long candidateSize = asset.optLong("size", 0);
                    if (candidateSize > 0 && candidateSize <= 128L * 1024 * 1024 && validReleaseUrl(candidate, repo, tag, true)) {
                        downloadUrl = candidate;
                        size = candidateSize;
                        break;
                    }
                }
            }
            synchronized (this) {
                if (revision != configurationRevision || !repo.equals(repository())) {
                    return status(result, "changed", "发布仓库已更换，请重新检查。");
                }
                checkedRepository = repo;
                checkedRelease = releaseUrl;
                checkedDownload = comparison > 0 ? downloadUrl : "";
            }
            if (comparison <= 0) return status(result, "current", "当前已是最新版本。");
            if (downloadUrl.isEmpty()) return status(result, "no_apk", "发现新版本，但尚未发布 NAI-Pocket-Library.apk 安装包。");
            result.put("available", true).put("downloadUrl", downloadUrl).put("size", size);
            return status(result, "available", "发现新版本。下载后在安卓系统中确认安装。");
        } catch (IOException | JSONException failure) {
            return status(result, "failed", "检查应用更新失败，请检查网络后重试。");
        }
    }

    synchronized Uri openTarget(String target) {
        String url = "download".equals(target) ? checkedDownload : "release".equals(target) ? checkedRelease : "";
        if (url.isEmpty() || !repository().equals(checkedRepository)) {
            throw new IllegalArgumentException("请先检查应用更新，再打开发布页面或下载新版。");
        }
        return Uri.parse(url);
    }

    private static JSONObject status(JSONObject result, String status, String message) {
        try {
            return result.put("status", status).put("message", message);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static boolean githubUri(URI uri) {
        return "https".equals(uri.getScheme()) && "github.com".equalsIgnoreCase(uri.getHost())
                && uri.getPort() == -1 && uri.getUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null;
    }

    static boolean validReleaseUrl(String input, String repository, String tag, boolean download) {
        try {
            URI uri = new URI(input);
            if (!githubUri(uri)) return false;
            String prefix = "/" + repository + (download ? "/releases/download/" : "/releases/tag/");
            String path = uri.getRawPath();
            return path.length() > prefix.length() && path.regionMatches(true, 0, prefix, 0, prefix.length())
                    && path.substring(prefix.length()).equals(tag + (download ? "/" + APK_NAME : ""));
        } catch (URISyntaxException failure) {
            return false;
        }
    }

    /** Numeric release tags only. Unknown syntax must never be reported as up to date. */
    static Integer compareVersions(String left, String right) {
        if (left == null || right == null || !left.matches("[vV]?[0-9]{1,9}(?:\\.[0-9]{1,9}){0,3}")
                || !right.matches("[vV]?[0-9]{1,9}(?:\\.[0-9]{1,9}){0,3}")) return null;
        String[] a = left.replaceFirst("^[vV]", "").split("\\.");
        String[] b = right.replaceFirst("^[vV]", "").split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length ? Integer.parseInt(a[i]) : 0;
            int y = i < b.length ? Integer.parseInt(b[i]) : 0;
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }
}
