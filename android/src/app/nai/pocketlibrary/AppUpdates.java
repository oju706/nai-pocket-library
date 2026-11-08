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

/** Checks public update metadata. Downloads and installation stay with the system browser. */
final class AppUpdates {
    private static final String APK_NAME = "NAI-Pocket-Library.apk";
    private static final String DEFAULT_REPOSITORY = "oju706/nai-pocket-library";
    private static final long DAY = 24 * 60 * 60 * 1000L;
    private static final long RETRY_INTERVAL = 15 * 60 * 1000L;
    private static final long MAX_APK_BYTES = 128L * 1024 * 1024;
    private final SharedPreferences preferences;
    private final String versionName;
    private final long versionCode;
    private long configurationRevision;
    private boolean checking;
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
                    .put("repository", repository()).put("autoUpdate", preferences.getBoolean("automatic", true))
                    .put("lastCheckedAt", preferences.getLong("lastCheckedAt", 0));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    synchronized JSONObject setRepository(String input) {
        String repository = normalizeRepository(input);
        String effectiveRepository = repository.isEmpty() ? DEFAULT_REPOSITORY : repository;
        if (effectiveRepository.equals(repository())) return info();
        SharedPreferences.Editor editor = preferences.edit();
        if (repository.isEmpty()) editor.remove("repository");
        else editor.putString("repository", repository);
        editor.remove("lastCheckedAt").remove("nextCheckAt").remove("failedChecks").apply();
        configurationRevision++;
        checkedRepository = checkedRelease = checkedDownload = "";
        return info();
    }

    synchronized JSONObject setAutomatic(boolean enabled) {
        preferences.edit().putBoolean("automatic", enabled).apply();
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
        return check(false);
    }

    JSONObject checkAutomatically() {
        return check(true);
    }

    private JSONObject check(boolean automatic) {
        String repo;
        long revision;
        JSONObject result;
        synchronized (this) {
            repo = repository();
            revision = configurationRevision;
            result = blankResult();
            if (checking) return status(result, automatic ? "skipped" : "busy", "正在检查应用更新。");
            if (automatic && !preferences.getBoolean("automatic", true)) return status(result, "skipped", "自动检查已关闭。");
            long now = System.currentTimeMillis();
            long next = preferences.getLong("nextCheckAt", 0);
            if (automatic && next > now && next - now <= DAY) return status(result, "skipped", "尚未到下次自动检查时间。");
            checking = true;
            checkedRepository = checkedRelease = checkedDownload = "";
        }
        try {
            try {
                checkRelease(repo, result);
                String releaseStatus = result.optString("status");
                if (DEFAULT_REPOSITORY.equals(repo) && ("unpublished".equals(releaseStatus) || "no_apk".equals(releaseStatus))) {
                    JSONObject fallback = blankResult();
                    if (checkManifest(repo, fallback)) result = fallback;
                }
            } catch (UpdateFailure failure) {
                result = status(blankResult(), failure.status, failure.getMessage());
            } catch (IOException | JSONException failure) {
                result = status(blankResult(), "failed", "检查应用更新失败，请检查网络后重试。");
            }
            synchronized (this) {
                if (revision != configurationRevision || !repo.equals(repository())) {
                    return status(blankResult(), "changed", "发布仓库已更换，请重新检查。");
                }
                if (automatic && !preferences.getBoolean("automatic", true)) {
                    return status(blankResult(), "skipped", "自动检查已关闭。");
                }
                checkedRepository = repo;
                checkedRelease = result.optString("releaseUrl");
                checkedDownload = result.optString("downloadUrl");
                updateSchedule(result);
            }
            return result;
        } finally {
            synchronized (this) { checking = false; }
        }
    }

    private JSONObject blankResult() {
        try {
            return info().put("available", false).put("latestVersion", "").put("releaseUrl", "")
                    .put("downloadUrl", "").put("body", "").put("size", 0).put("sha256", "");
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private void updateSchedule(JSONObject result) {
        long now = System.currentTimeMillis();
        String status = result.optString("status");
        boolean failed = "failed".equals(status) || "unavailable".equals(status) || "invalid_manifest".equals(status);
        int failures = failed ? Math.min(6, preferences.getInt("failedChecks", 0) + 1) : 0;
        long delay = failed ? Math.min(6 * 60 * 60 * 1000L, RETRY_INTERVAL << (failures - 1)) : DAY;
        preferences.edit().putLong("lastCheckedAt", now).putLong("nextCheckAt", now + delay).putInt("failedChecks", failures).apply();
        try {
            result.put("lastCheckedAt", now).put("autoUpdate", preferences.getBoolean("automatic", true));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private boolean checkManifest(String repo, JSONObject result) throws IOException, JSONException {
        JSONObject ref = readJson("https://api.github.com/repos/" + repo + "/git/ref/heads/main", 16 * 1024, true);
        if (ref == null) return false;
        JSONObject target = ref.optJSONObject("object");
        String sha = target == null ? "" : target.optString("sha");
        if (!"refs/heads/main".equals(ref.optString("ref")) || target == null || !"commit".equals(target.optString("type"))
                || !sha.matches("[0-9a-f]{40}")) {
            throw new UpdateFailure("invalid_manifest", "无法验证主分支的发布位置。");
        }
        String root = "https://raw.githubusercontent.com/" + repo + "/" + sha + "/release/";
        JSONObject manifest;
        try {
            manifest = readJson(root + "update.json", 16 * 1024, false);
        } catch (JSONException failure) {
            throw new UpdateFailure("invalid_manifest", "仓库的更新清单格式有误，暂时无法检查此版本。");
        }
        if (manifest == null) return false;
        validateManifest(manifest);
        long candidateCode = manifest.getLong("versionCode");
        String candidateName = manifest.getString("versionName");
        Integer comparison = compareVersions(candidateName, versionName);
        if (comparison == null || candidateCode > versionCode && comparison < 0) {
            throw new UpdateFailure("invalid_manifest", "更新清单的版本号与应用版本不匹配。");
        }
        result.put("latestVersion", candidateName).put("latestVersionCode", candidateCode)
                .put("body", manifest.optString("notes", ""))
                .put("releaseUrl", "https://github.com/" + repo + "/tree/" + sha + "/release");
        if (candidateCode <= versionCode) {
            status(result, "current", "当前已是最新版本。");
        } else {
            result.put("available", true).put("downloadUrl", root + APK_NAME)
                    .put("size", manifest.getLong("bytes")).put("sha256", manifest.getString("sha256").toLowerCase(Locale.ROOT));
            status(result, "available", "发现新版本。下载后在安卓系统中确认安装。");
        }
        return true;
    }

    static void validateManifest(JSONObject manifest) throws IOException {
        Object version = manifest.opt("versionName");
        long code = integer(manifest.opt("versionCode"));
        long size = integer(manifest.opt("bytes"));
        Object checksum = manifest.opt("sha256");
        Object notes = manifest.opt("notes");
        if (!(version instanceof String) || compareVersions((String) version, "0") == null
                || code <= 0 || code > Integer.MAX_VALUE || size <= 0 || size > MAX_APK_BYTES
                || !APK_NAME.equals(manifest.opt("file")) || !(checksum instanceof String)
                || !((String) checksum).matches("[a-fA-F0-9]{64}")
                || (notes != null && (!(notes instanceof String) || ((String) notes).length() > 4000))) {
            throw new UpdateFailure("invalid_manifest", "仓库的更新清单格式有误，暂时无法检查此版本。");
        }
    }

    private static long integer(Object value) {
        return value instanceof Integer || value instanceof Long ? ((Number) value).longValue() : -1;
    }

    private void checkRelease(String repo, JSONObject result) throws IOException, JSONException {
        JSONObject release = readJson("https://api.github.com/repos/" + repo + "/releases/latest", 512 * 1024, true);
        if (release == null || release.optBoolean("draft", true) || release.optBoolean("prerelease", true)) {
            status(result, "unpublished", "这个仓库暂无可检查的更新清单或正式发布。仓库地址正确时，等待新版发布即可。");
            return;
        }
        String tag = release.optString("tag_name", "");
        String releaseUrl = release.optString("html_url", "");
        String text = release.optString("body", "");
        result.put("latestVersion", tag).put("body", text.substring(0, Math.min(text.length(), 4000)));
        Integer comparison = compareVersions(tag, versionName);
        if (comparison == null) {
            status(result, "unsupported_version", "发布版本号无法自动比较，请作者使用 v1.1 这样的数字版本号。");
            return;
        }
        if (!validReleaseUrl(releaseUrl, repo, tag, false)) {
            status(result, "unavailable", "发布链接与配置的仓库不一致，暂时无法打开。");
            return;
        }
        result.put("releaseUrl", releaseUrl);
        if (comparison <= 0) {
            status(result, "current", "当前已是最新版本。");
            return;
        }
        JSONArray assets = release.optJSONArray("assets");
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null || !APK_NAME.equals(asset.optString("name")) || !"uploaded".equals(asset.optString("state"))) continue;
                String candidate = asset.optString("browser_download_url", "");
                long size = asset.optLong("size", 0);
                if (size <= 0 || size > MAX_APK_BYTES || !validReleaseUrl(candidate, repo, tag, true)) continue;
                String digest = asset.optString("digest", "");
                if (digest.matches("sha256:[a-fA-F0-9]{64}")) result.put("sha256", digest.substring(7).toLowerCase(Locale.ROOT));
                result.put("available", true).put("downloadUrl", candidate).put("size", size);
                status(result, "available", "发现新版本。下载后在安卓系统中确认安装。");
                return;
            }
        }
        status(result, "no_apk", "发现新版本，但尚未发布 NAI-Pocket-Library.apk 安装包。");
    }

    private JSONObject readJson(String address, int limit, boolean api) throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(15000);
        if (api) {
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
        }
        connection.setRequestProperty("User-Agent", "NAI-Pocket-Library/" + versionName);
        try {
            int code = connection.getResponseCode();
            if (code == 404) return null;
            if (code == 403 || code == 429) throw new UpdateFailure("failed", "GitHub 暂时限制检查频率，请稍后重试。");
            if (code >= 300 && code < 400) throw new UpdateFailure("unavailable", "仓库地址可能已变更，请在设置中填写新的仓库地址。");
            if (code != 200 || connection.getContentLengthLong() > limit) throw new IOException("Unexpected update metadata");
            try (InputStream input = connection.getInputStream()) {
                return new JSONObject(new String(NaxLibrary.readBounded(input, limit), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }

    private static final class UpdateFailure extends IOException {
        final String status;

        UpdateFailure(String status, String message) {
            super(message);
            this.status = status;
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
