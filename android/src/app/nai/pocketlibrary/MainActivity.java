package app.nai.pocketlibrary;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final int PICK_IMAGE = 31;
    private static final int PICK_PACK = 32;
    private static final int PICK_GALLERY = 33;
    private static final int PICK_ONLINE_EXPORT = 34;
    private static final int PICK_SHARED_STYLE = 35;
    private static final int GALLERY_BATCH_LIMIT = 40;
    private static final int COPY_LIMIT = 256 * 1024;
    private static final String PACK_CACHE_LIMIT = "limit-mib";
    private static final int DEFAULT_PACK_CACHE_LIMIT = 256;
    private static final int PAPER = Color.rgb(246, 244, 237);
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private final ExecutorService updateChecks = Executors.newSingleThreadExecutor();
    private OnlinePacks onlinePacks;
    private PackPhotoCache photoCache;
    private SharedPreferences packCacheSettings;
    private int picker;
    private int pickerRequest;
    private boolean remotePackImport;
    private boolean galleryOperation;
    private WebView web;
    private NaxLibrary nax;
    private KoreanLibrary korean;
    private KoreanLibrary korean33000;
    private KoreanLibrary korean55000;
    private LocalPacks packs;
    private SharedStylePacks sharedStyles;
    private AppUpdates updates;
    private AppUpdateInstaller installer;
    private LibraryBackup backup;
    private ImagePrompts imagePrompts;
    private GalleryStore gallery;
    private OnlinePacks.Export onlineExport;
    private volatile File onlineGalleryTemp;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        nax = new NaxLibrary(this);
        korean = new KoreanLibrary(this);
        korean33000 = new KoreanLibrary(this, "33000");
        korean55000 = new KoreanLibrary(this, "55000");
        packs = new LocalPacks(this);
        packCacheSettings = getSharedPreferences("online-pack-cache", MODE_PRIVATE);
        photoCache = new PackPhotoCache(new File(getCacheDir(), "online-pack-images"),
                packCacheSettings.getInt(PACK_CACHE_LIMIT, DEFAULT_PACK_CACHE_LIMIT));
        onlinePacks = new OnlinePacks(photoCache);
        sharedStyles = new SharedStylePacks(this, photoCache);
        files.execute(() -> {
            OnlinePacks.clearExpiredExports(getCacheDir());
            photoCache.bytes();
        });
        updates = new AppUpdates(this);
        installer = new AppUpdateInstaller(this);
        backup = new LibraryBackup(this, this::send);
        imagePrompts = new ImagePrompts(this, this::send);
        gallery = GalleryStore.get(this);
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(PAPER);
        getWindow().setStatusBarColor(PAPER);
        getWindow().setNavigationBarColor(PAPER);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            frame.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        web = new WebView(this);
        web.setBackgroundColor(PAPER);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOME.equals(request.getUrl().toString());
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serve(request);
            }
        });
        web.addJavascriptInterface(new Bridge(), "Pocket");
        frame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        web.loadUrl(HOME);
    }

    private WebResourceResponse serve(WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!"GET".equals(request.getMethod()) || !"https".equals(url.getScheme()) || !HOST.equals(url.getHost())) return unavailable();
        String path = url.getPath();
        try {
            if ("/index.html".equals(path)) return response("text/html", getAssets().open("index.html"), false);
            if ("/style.css".equals(path)) return response("text/css", getAssets().open("style.css"), false);
            if ("/app.js".equals(path)) return response("text/javascript", getAssets().open("app.js"), false);
            if ("/sources.js".equals(path)) return response("text/javascript", getAssets().open("sources.js"), false);
            if ("/gallery.css".equals(path)) return response("text/css", getAssets().open("gallery.css"), false);
            if ("/gallery.js".equals(path)) return response("text/javascript", getAssets().open("gallery.js"), false);
            if ("/online-pack.js".equals(path)) return response("text/javascript", getAssets().open("online-pack.js"), false);
            if ("/online-pack.css".equals(path)) return response("text/css", getAssets().open("online-pack.css"), false);
            if ("/api/gallery-packs.json".equals(path)) {
                byte[] index = onlinePacks.galleryIndex().toString()
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                return response("application/json", new ByteArrayInputStream(index), false);
            }
            if ("/api/korean.json".equals(path)) return response("application/json", koreanPack(url.getQueryParameter("pack")).openIndex(), false);
            if ("/api/korean-status.json".equals(path)) {
                byte[] status = koreanPack(url.getQueryParameter("pack")).status("1".equals(url.getQueryParameter("check")))
                        .toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                return response("application/json", new ByteArrayInputStream(status), false);
            }
            if ("/api/nax.json".equals(path)) {
                NaxLibrary.Catalog catalog = nax.openIndex("1".equals(url.getQueryParameter("check")));
                HashMap<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                headers.put("X-Pocket-Update", catalog.status);
                headers.put("X-Pocket-Revision", catalog.revision);
                return new WebResourceResponse("application/json", "UTF-8", 200, "OK", headers, catalog.data);
            }
            List<String> parts = url.getPathSegments();
            if (parts.size() == 2 && "gallery-image".equals(parts.get(0))) {
                GalleryStore.Entry image = gallery.entry(parts.get(1));
                if ("1".equals(url.getQueryParameter("thumb")) || "1".equals(url.getQueryParameter("preview"))) {
                    return response("image/jpeg", new ByteArrayInputStream(gallery.preview(image)), false);
                }
                return response(image.originalMime, gallery.original(image), false);
            }
            if (parts.size() == 3 && "api".equals(parts.get(0)) && "pack".equals(parts.get(1)) && parts.get(2).endsWith(".json")) {
                String file = parts.get(2);
                return response("application/json", packs.openIndex(file.substring(0, file.length() - 5)), false);
            }
            WebResourceResponse photo = libraryPhoto(parts);
            if (photo != null) return photo;
        } catch (Exception ignored) {
            return unavailable();
        }
        return unavailable();
    }

    private WebResourceResponse libraryPhoto(List<String> parts) throws IOException, JSONException {
        int count = parts.size();
        if (count == 3 && ("online-pack-image".equals(parts.get(0)) || "online-pack-thumb".equals(parts.get(0)))) {
            boolean thumbnail = "online-pack-thumb".equals(parts.get(0));
            byte[] bytes = onlinePacks.photo(parts.get(1), parts.get(2), thumbnail);
            return response(NaxLibrary.imageType(bytes), new ByteArrayInputStream(bytes), false);
        }
        if (count == 3) {
            String route = parts.get(0);
            boolean localStyle = SharedStylePacks.ORIGINAL_ROUTE.equals(route) || SharedStylePacks.PREVIEW_ROUTE.equals(route);
            boolean remoteStyle = SharedStylePacks.REMOTE_ORIGINAL_ROUTE.equals(route) || SharedStylePacks.REMOTE_PREVIEW_ROUTE.equals(route);
            if (localStyle || remoteStyle) {
                boolean thumbnail = SharedStylePacks.PREVIEW_ROUTE.equals(route) || SharedStylePacks.REMOTE_PREVIEW_ROUTE.equals(route);
                byte[] bytes = sharedStyles.photo(parts.get(1), parts.get(2), thumbnail, remoteStyle);
                return response(NaxLibrary.imageType(bytes), new ByteArrayInputStream(bytes), false);
            }
        }
        if ((count == 3 || count == 4) && "korean-image".equals(parts.get(0))) {
            KoreanLibrary pack = count == 3 ? korean : koreanPack(parts.get(1));
            KoreanLibrary.Preview photo = pack.preview(Long.parseLong(parts.get(count - 2)), Integer.parseInt(parts.get(count - 1)));
            return response(photo.type, new ByteArrayInputStream(photo.bytes), false);
        }
        if (count == 3 && "nax-image".equals(parts.get(0))) {
            return response("image/webp", nax.openPreview(parts.get(1), parts.get(2)), true);
        }
        if (count == 4 && "pack-image".equals(parts.get(0))) {
            byte[] bytes = packs.image(parts.get(1), Long.parseLong(parts.get(2)), Integer.parseInt(parts.get(3)));
            String type = NaxLibrary.imageType(bytes);
            if (type != null) return response(type, new ByteArrayInputStream(bytes), false);
        }
        return null;
    }

    private static WebResourceResponse response(String type, InputStream content, boolean cached) {
        return new WebResourceResponse(type, type.startsWith("image/") ? null : "UTF-8", 200, "OK",
                Collections.singletonMap("Cache-Control", cached ? "private, max-age=604800" : "no-store"), content);
    }

    private static WebResourceResponse unavailable() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Unavailable",
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }

    private KoreanLibrary koreanPack(String pack) throws IOException {
        if (pack == null || "curated".equals(pack)) return korean;
        if ("33000".equals(pack)) return korean33000;
        if ("55000".equals(pack)) return korean55000;
        throw new IOException("未知画师图包。");
    }

    private final class Bridge {
        @JavascriptInterface
        public void request(String raw) {
            if (raw == null || raw.length() > 42 * 1024 * 1024) return;
            try {
                JSONObject request = new JSONObject(raw);
                int id = request.getInt("id");
                String action = request.getString("action");
                boolean extendedCopy = "copy".equals(action) && raw.length() <= 2 * 1024 * 1024;
                if (raw.length() > 128000 && !"exportBackup".equals(action) && !extendedCopy) {
                    runOnUiThread(() -> send(id, null, "请求内容过大。"));
                    return;
                }
                String value = request.optString("value", "");
                runOnUiThread(() -> dispatch(id, action, value));
            } catch (Exception ignored) {
                // The bundled client sends JSON requests.
            }
        }
    }

    private void dispatch(int id, String action, String value) {
        try {
            switch (action) {
                case "copy":
                    if (value.isEmpty()) {
                        send(id, null, "没有可复制的内容。");
                        return;
                    }
                    if (value.length() > COPY_LIMIT || value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > COPY_LIMIT) {
                        send(id, null, "内容超过单次复制上限，可以逐项复制。");
                        return;
                    }
                    ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                    if (clipboard == null) {
                        send(id, null, "系统剪贴板暂不可用。");
                        return;
                    }
                    try {
                        clipboard.setPrimaryClip(ClipData.newPlainText("NAI 口袋词库", value));
                    } catch (RuntimeException failure) {
                        send(id, null, "系统未能复制这些内容。");
                        return;
                    }
                    send(id, true, null);
                    return;
                case "listPacks":
                    send(id, packs.list(), null);
                    return;
                case "listGallery":
                    files.execute(() -> {
                        try {
                            Object entries = gallery.list(value.isEmpty() ? 0 : Integer.parseInt(value));
                            runOnUiThread(() -> send(id, entries, null));
                        } catch (Exception failure) {
                            runOnUiThread(() -> send(id, null, "无法读取图库目录，请重试。"));
                        }
                    });
                    return;
                case "deleteGalleryImage":
                    if (fileOperationBusy()) {
                        send(id, null, "已有文件操作正在进行，请稍后再删除。");
                        return;
                    }
                    deleteGalleryImage(id, value);
                    return;
                case "importGallery":
                    choose(id, PICK_GALLERY, "image/*");
                    return;
                case "openOnlinePack":
                    files.execute(() -> {
                        try {
                            JSONObject catalog = onlinePacks.open(value);
                            runOnUiThread(() -> send(id, catalog, null));
                        } catch (IOException | JSONException failure) {
                            String error = failure instanceof IOException ? failure.getMessage() : "在线图包目录格式不正确。";
                            runOnUiThread(() -> send(id, null, error == null ? "无法读取在线图包。" : error));
                        }
                    });
                    return;
                case "packCacheInfo":
                case "setPackCacheLimit":
                case "clearPackCache":
                    files.execute(() -> packCacheAction(id, action, value));
                    return;
                case "openSharedStylePack":
                case "openRemoteSharedStylePack":
                    files.execute(() -> {
                        try {
                            JSONObject catalog = "openRemoteSharedStylePack".equals(action) ? sharedStyles.openRemote() : sharedStyles.open();
                            runOnUiThread(() -> send(id, catalog, null));
                        } catch (Exception failure) {
                            runOnUiThread(() -> send(id, null, sharedStyleError(failure)));
                        }
                    });
                    return;
                case "importSharedStylePack":
                    choose(id, PICK_SHARED_STYLE, "*/*");
                    return;
                case "forgetSharedStylePack":
                    if (fileOperationBusy()) {
                        send(id, null, "正在读取其他图片或文件，请稍后再试。");
                        return;
                    }
                    files.execute(() -> {
                        try {
                            sharedStyles.forget();
                            runOnUiThread(() -> send(id, true, null));
                        } catch (IOException failure) {
                            runOnUiThread(() -> send(id, null, failure.getMessage()));
                        }
                    });
                    return;
                case "saveOnlinePhotos":
                case "saveSharedStylePhotos":
                case "saveRemoteSharedStylePhotos":
                    if (fileOperationBusy()) {
                        send(id, null, "正在读取其他图片或文件，请稍后再试。");
                        return;
                    }
                    prepareOnlineExport(id, value, action);
                    return;
                case "photoMetadata":
                    if (fileOperationBusy()) {
                        send(id, null, "正在读取其他图片或文件，请稍后再试。");
                        return;
                    }
                    readPhotoMetadata(id, value);
                    return;
                case "saveOnlineToGallery":
                case "exportPackImageHtml":
                    if (fileOperationBusy()) {
                        send(id, null, "正在读取其他图片或文件，请稍后再试。");
                        return;
                    }
                    packImageToGallery(id, value, "exportPackImageHtml".equals(action));
                    return;
                case "galleryMetadata":
                case "exportGalleryHtml":
                case "exportGalleryOriginal":
                case "saveLastOriginal":
                    if (fileOperationBusy()) {
                        send(id, null, "已有文件选择或导入正在进行。");
                        return;
                    }
                    if ("galleryMetadata".equals(action)) readGalleryMetadata(id, value);
                    else if ("exportGalleryHtml".equals(action)) exportGalleryHtml(id, value);
                    else if ("exportGalleryOriginal".equals(action)) exportGalleryOriginal(id, value);
                    else saveLastOriginal(id);
                    return;
                case "hasOnline":
                    send(id, nax.hasIndex(), null);
                    return;
                case "appInfo":
                    send(id, updates.info(), null);
                    return;
                case "setUpdateRepository":
                    send(id, updates.setRepository(value), null);
                    return;
                case "setAutoUpdate":
                    send(id, updates.setAutomatic(Boolean.parseBoolean(value)), null);
                    return;
                case "checkAppUpdate":
                case "checkAutomaticUpdate":
                case "downloadAppUpdate":
                    updateChecks.execute(() -> checkUpdate(id, action));
                    return;
                case "installAppUpdate":
                    try {
                        Intent intent = installer.installIntent();
                        startActivity(intent);
                        send(id, Intent.ACTION_VIEW.equals(intent.getAction()) ? "install" : "permission", null);
                    } catch (IOException failure) { send(id, null, failure.getMessage()); }
                    return;
                case "openAppRelease":
                    startActivity(new Intent(Intent.ACTION_VIEW, updates.openTarget(value)));
                    send(id, true, null);
                    return;
                case "exportBackup":
                case "importBackup":
                case "readImagePrompts":
                    if (fileOperationBusy()) {
                        send(id, null, "已有文件选择或导入正在进行。");
                        return;
                    }
                    if ("exportBackup".equals(action)) backup.exportBackup(id, value);
                    else if ("importBackup".equals(action)) backup.importBackup(id);
                    else imagePrompts.readImagePrompts(id);
                    return;
                case "pickImage":
                    choose(id, PICK_IMAGE, "image/*");
                    return;
                case "importPack":
                    choose(id, PICK_PACK, "*/*");
                    return;
                case "importRemotePack":
                    if (fileOperationBusy()) { send(id, null, "已有文件选择或导入正在进行。"); return; }
                    remotePackImport = true;
                    files.execute(() -> {
                        try {
                            JSONObject imported = packs.importRemoteZip(value, this::packProgress);
                            runOnUiThread(() -> finishRemotePack(id, imported, null));
                        } catch (Exception failure) {
                            String error = failure instanceof IOException && failure.getMessage() != null
                                    ? failure.getMessage() : "下载或导入 ZIP 失败，请检查地址后重试。";
                            runOnUiThread(() -> finishRemotePack(id, null, error));
                        }
                    });
                    return;
                case "openLink":
                    Uri uri = Uri.parse(value);
                    if (!"https".equals(uri.getScheme()) || !Arrays.asList("arca.live", "nax.moe", "gall.dcinside.com",
                            "docs.novelai.net", "creativecommons.org", "huggingface.co").contains(uri.getHost())) {
                        send(id, null, "无法打开这个来源。");
                        return;
                    }
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    send(id, true, null);
                    return;
                default:
                    send(id, null, "此操作暂不可用。");
            }
        } catch (IllegalArgumentException failure) {
            send(id, null, failure.getMessage() == null ? "输入内容无效。" : failure.getMessage());
        } catch (RuntimeException failure) {
            send(id, null, "无法完成操作，请重试。");
        }
    }

    private void checkUpdate(int id, String action) {
        try {
            boolean automatic = "checkAutomaticUpdate".equals(action);
            JSONObject result = automatic ? updates.checkAutomatically() : updates.check();
            if (result.optBoolean("available") && (automatic || "downloadAppUpdate".equals(action))) {
                try { result = installer.download(result); }
                catch (IOException failure) { result.put("downloadError", failure.getMessage() == null ? "暂时无法下载更新。" : failure.getMessage()); }
            } else if ("skipped".equals(result.optString("status"))) {
                JSONObject ready = installer.ready();
                if (ready.optBoolean("downloaded")) result = ready;
            }
            JSONObject response = result;
            runOnUiThread(() -> send(id, response, null));
        } catch (Exception failure) {
            runOnUiThread(() -> send(id, null, "暂时无法检查更新，请稍后重试。"));
        }
    }

    private boolean fileOperationBusy() {
        return picker != 0 || remotePackImport || galleryOperation || backup.isBusy() || imagePrompts.isBusy();
    }

    private void packCacheAction(int id, String action, String value) {
        try {
            int limit = packCacheSettings.getInt(PACK_CACHE_LIMIT, DEFAULT_PACK_CACHE_LIMIT);
            if ("setPackCacheLimit".equals(action)) {
                if (!Arrays.asList("0", "128", "256", "512", "1024", "2048", "4096").contains(value)) {
                    throw new IllegalArgumentException("缓存上限选项无效。");
                }
                limit = Integer.parseInt(value);
                if (!packCacheSettings.edit().putInt(PACK_CACHE_LIMIT, limit).commit()) throw new IOException("无法保存缓存设置。");
                photoCache.setLimit(limit);
            } else if ("clearPackCache".equals(action)) {
                photoCache.clear();
            }
            JSONObject result = new JSONObject().put("limitMiB", limit).put("bytes", photoCache.bytes());
            runOnUiThread(() -> send(id, result, null));
        } catch (Exception failure) {
            runOnUiThread(() -> send(id, null, "无法更新在线图包缓存，请重试。"));
        }
    }

    private void prepareOnlineExport(int id, String selection, String action) {
        galleryOperation = true;
        files.execute(() -> {
            try {
                OnlinePacks.Export export = "saveOnlinePhotos".equals(action) ? onlinePacks.prepareExport(selection, getCacheDir())
                        : sharedStyles.prepareExport(selection, getCacheDir(), "saveRemoteSharedStylePhotos".equals(action));
                runOnUiThread(() -> {
                    galleryOperation = false;
                    if (web == null || isFinishing()) {
                        export.file.delete();
                        return;
                    }
                    Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                            .setType(export.mime).putExtra(Intent.EXTRA_TITLE, export.name);
                    try {
                        startActivityForResult(save, PICK_ONLINE_EXPORT);
                        onlineExport = export;
                        picker = PICK_ONLINE_EXPORT;
                        pickerRequest = id;
                    } catch (RuntimeException failure) {
                        export.file.delete();
                        send(id, null, "无法打开安卓文件保存窗口。");
                    }
                });
            } catch (Exception | OutOfMemoryError failure) {
                String error = failure instanceof IOException ? failure.getMessage() : "无法准备所选原图，请重试。";
                runOnUiThread(() -> {
                    galleryOperation = false;
                    send(id, null, error == null ? "无法准备所选原图，请重试。" : error);
                });
            }
        });
    }

    private void finishOnlineExport(int id, Uri uri) {
        OnlinePacks.Export export = onlineExport;
        onlineExport = null;
        if (uri == null || !"content".equals(uri.getScheme()) || export == null) {
            if (export != null) export.file.delete();
            picker = 0;
            send(id, null, null);
            return;
        }
        files.execute(() -> {
            String error = null;
            try (OutputStream output = getContentResolver().openOutputStream(uri, "w")) {
                if (output == null) throw new IOException("无法写入所选位置。");
                Files.copy(export.file.toPath(), output);
            } catch (Exception failure) {
                error = "保存文件失败，请检查手机空间并重试。";
            } finally {
                export.file.delete();
            }
            String message = error;
            runOnUiThread(() -> {
                picker = 0;
                send(id, message == null ? true : null, message);
            });
        });
    }

    private void readPhotoMetadata(int id, String reference) {
        Uri uri = Uri.parse(reference);
        if (reference.length() > 2048 || !reference.startsWith("/") || reference.startsWith("//")
                || uri.getAuthority() != null || uri.getFragment() != null) {
            send(id, null, "这张图没有有效的图包引用。");
            return;
        }
        galleryOperation = true;
        files.execute(() -> {
            try {
                WebResourceResponse photo = libraryPhoto(uri.getPathSegments());
                if (photo == null) throw new IOException("无法打开图包样图。");
                byte[] bytes;
                try (InputStream input = photo.getData()) {
                    bytes = NaxLibrary.readBounded(input, ImagePrompts.MAX_INPUT);
                }
                runOnUiThread(() -> {
                    galleryOperation = false;
                    if (web != null) imagePrompts.readPhoto(id, bytes);
                });
            } catch (Exception | OutOfMemoryError failure) {
                runOnUiThread(() -> {
                    galleryOperation = false;
                    send(id, null, "图包样图暂时无法读取，请重试。");
                });
            }
        });
    }

    private void packImageToGallery(int id, String request, boolean exportOnly) {
        JSONObject input;
        List<String> path;
        try {
            input = new JSONObject(request);
            String reference = input.getString("reference");
            Uri route = Uri.parse(reference);
            if (reference.length() > 2048 || !reference.startsWith("/") || reference.startsWith("//")
                    || route.getAuthority() != null || route.getFragment() != null || route.getQuery() != null) {
                throw new IOException("这张图没有有效的图包引用。");
            }
            path = route.getPathSegments();
            if (path.size() != 3 || !("online-pack-image".equals(path.get(0))
                    || SharedStylePacks.ORIGINAL_ROUTE.equals(path.get(0))
                    || SharedStylePacks.REMOTE_ORIGINAL_ROUTE.equals(path.get(0)))) {
                throw new IOException("请选择图包中的原图。");
            }
        } catch (Exception failure) {
            send(id, null, "无法确认要保存的在线图包图片。");
            return;
        }

        JSONObject source = new JSONObject();
        try {
            source.put("title", input.optString("label", ""))
                    .put("source", input.optString("source", ""))
                    .put("revision", input.optString("revision", ""))
                    .put("imageId", input.optString("imageId", ""));
        } catch (JSONException impossible) {
            send(id, null, "无法确认要保存的在线图包信息。");
            return;
        }

        galleryOperation = true;
        files.execute(() -> {
            File temporary = null;
            try {
                WebResourceResponse photo = libraryPhoto(path);
                if (photo == null) throw new IOException("在线图包原图无法加载。");
                temporary = File.createTempFile("pocket-online-export-", ".tmp", getCacheDir());
                onlineGalleryTemp = temporary;
                try (InputStream stream = photo.getData(); FileOutputStream output = new FileOutputStream(temporary)) {
                    copyGalleryOriginal(stream, output);
                }
                File sourceFile = temporary;
                runOnUiThread(() -> {
                    if (web == null || isFinishing()) {
                        cleanupOnlineGalleryTemp(sourceFile);
                        galleryOperation = false;
                        return;
                    }
                    ImagePrompts.Result completion = (resultId, value, error) -> {
                        JSONObject summary = value instanceof JSONObject ? (JSONObject)value : null;
                        if (!exportOnly && (error != null || summary == null)) {
                            cleanupOnlineGalleryTemp(sourceFile);
                            String message = error == null || error.isEmpty()
                                    ? "无法读取在线图包原图的生成信息，未保存到图库。"
                                    : "无法读取在线图包原图的生成信息，未保存到图库：" + error;
                            finishOnlineGallerySave(id, null, message);
                            return;
                        }
                        files.execute(() -> {
                            if (exportOnly) {
                                exportPackImageHtml(id, sourceFile, input, source, summary, error);
                                return;
                            }
                            JSONObject saved = null;
                            String message = null;
                            try {
                                saved = gallery.savePacked(sourceFile, input.optString("name", "在线图包图片"),
                                        source, summary);
                            } catch (Exception | OutOfMemoryError failure) {
                                message = failure instanceof IOException && failure.getMessage() != null
                                        ? failure.getMessage() : "无法保存在线图包图片到图库，请重试。";
                            } finally {
                                cleanupOnlineGalleryTemp(sourceFile);
                            }
                            JSONObject result = saved;
                            String problem = message;
                            runOnUiThread(() -> finishOnlineGallerySave(id, result, problem));
                        });
                    };
                    try {
                        imagePrompts.readGallery(id, sourceFile, completion);
                    } catch (RuntimeException failure) {
                        cleanupOnlineGalleryTemp(sourceFile);
                        finishOnlineGallerySave(id, null, "无法读取在线图包原图，未保存到图库。");
                    }
                });
            } catch (Exception | OutOfMemoryError failure) {
                cleanupOnlineGalleryTemp(temporary);
                String message = failure instanceof IOException && failure.getMessage() != null
                        ? failure.getMessage() : "在线图包原图无法加载，未保存到图库。";
                runOnUiThread(() -> finishOnlineGallerySave(id, null, message));
            }
        });
    }

    private void exportPackImageHtml(int id, File original, JSONObject input, JSONObject source,
                                     JSONObject summary, String unavailableReason) {
        try {
            JSONObject photo = new JSONObject().put("name", input.optString("name", "图包图片"))
                    .put("source", source.optString("title")).put("sourcePage", source.optString("source"))
                    .put("id", source.optString("imageId")).put("sourceRevision", source.optString("revision"))
                    .put("storageKind", "pack-preview");
            OnlinePacks.Export export = GalleryShare.prepare(getCacheDir(), photo,
                    gallery.previewPacked(original), summary, unavailableReason);
            runOnUiThread(() -> launchDocumentExport(id, export));
        } catch (Exception | OutOfMemoryError failure) {
            String error = failure instanceof IOException && failure.getMessage() != null
                    ? failure.getMessage() : "无法导出图包图文，请重试。";
            runOnUiThread(() -> finishOnlineGallerySave(id, null, error));
        } finally {
            cleanupOnlineGalleryTemp(original);
        }
    }

    private void finishOnlineGallerySave(int id, JSONObject value, String error) {
        galleryOperation = false;
        send(id, value, error);
    }

    private void cleanupOnlineGalleryTemp(File temporary) {
        if (temporary != null) temporary.delete();
        if (onlineGalleryTemp == temporary) onlineGalleryTemp = null;
    }

    private void readGalleryMetadata(int id, String entryId) {
        galleryOperation = true;
        files.execute(() -> {
            GalleryStore.Entry entry;
            JSONObject cached = null;
            try {
                entry = gallery.entry(entryId);
                try {
                    cached = gallery.cachedPrompt(entryId);
                } catch (Exception ignored) {
                    // A damaged cache must not prevent trying the still-readable source.
                }
            } catch (Exception failure) {
                String message = failure instanceof IOException && failure.getMessage() != null
                        ? failure.getMessage() : "无法打开图库条目。";
                runOnUiThread(() -> finishGalleryMetadata(id, null, message));
                return;
            }
            if (cached != null) {
                JSONObject summary = cached;
                runOnUiThread(() -> finishGalleryMetadata(id, summary, null));
                return;
            }

            GalleryStore.Entry source = entry;
            runOnUiThread(() -> {
                if (web == null) {
                    galleryOperation = false;
                    return;
                }
                ImagePrompts.Result completion = (resultId, value, error) -> {
                    JSONObject summary = value instanceof JSONObject ? (JSONObject)value : null;
                    if (error != null || summary == null) {
                        finishGalleryMetadata(id, null, error == null
                                ? "无法读取这张原图的生成信息。" : error);
                        return;
                    }
                    cacheGalleryMetadata(id, entryId, summary);
                };
                try {
                    if (source.originalFile != null) {
                        imagePrompts.readGallery(id, source.originalFile, completion);
                    } else if (source.sourceUri != null) {
                        imagePrompts.readGallery(id, source.sourceUri, completion);
                    } else {
                        finishGalleryMetadata(id, null, "手机原图已不可读取，图库中只有预览。");
                    }
                } catch (RuntimeException failure) {
                    finishGalleryMetadata(id, null, "手机原图已移动或读取权限已失效，仍可查看缓存预览。");
                }
            });
        });
    }

    private void cacheGalleryMetadata(int id, String entryId, JSONObject summary) {
        files.execute(() -> {
            boolean cached = false;
            try {
                cached = gallery.savePrompt(entryId, summary);
            } catch (Exception ignored) {
                // The current session can still show the parsed result if the small cache fails.
            }
            try {
                summary.put("promptCached", cached);
            } catch (Exception ignored) {
                // Keep the original parsed object as-is.
            }
            runOnUiThread(() -> finishGalleryMetadata(id, summary, null));
        });
    }

    private void finishGalleryMetadata(int id, JSONObject value, String error) {
        galleryOperation = false;
        send(id, value, error);
    }

    private void exportGalleryHtml(int id, String entryId) {
        galleryOperation = true;
        files.execute(() -> {
            try {
                GalleryStore.Entry entry = gallery.entry(entryId);
                JSONObject cached = gallery.cachedPrompt(entryId);
                byte[] preview = gallery.preview(entry);
                String reason = cached == null
                        ? "图库中没有可导出的生成信息；原图不可读取或未包含可识别参数。"
                        : null;
                OnlinePacks.Export export = GalleryShare.prepare(getCacheDir(), entry, preview, cached, reason);
                runOnUiThread(() -> launchDocumentExport(id, export));
            } catch (Exception | OutOfMemoryError failure) {
                String message = failure instanceof IOException && failure.getMessage() != null
                        ? failure.getMessage() : "无法准备图库导出，请重试。";
                runOnUiThread(() -> {
                    galleryOperation = false;
                    send(id, null, message);
                });
            }
        });
    }

    private void exportGalleryOriginal(int id, String entryId) {
        galleryOperation = true;
        files.execute(() -> {
            File stage = null;
            try {
                GalleryStore.Entry entry = gallery.entry(entryId);
                stage = File.createTempFile("pocket-online-export-", ".tmp", getCacheDir());
                try (InputStream original = gallery.original(entry); FileOutputStream output = new FileOutputStream(stage)) {
                    copyGalleryOriginal(original, output);
                }
                String mime = entry.originalMime;
                String extension = "image/png".equals(mime) ? ".png" : "image/webp".equals(mime) ? ".webp" : ".jpg";
                String name = entry.name.replaceAll("(?i)\\.(?:png|webp|jpe?g)$", "") + extension;
                OnlinePacks.Export export = new OnlinePacks.Export(stage, name, mime);
                runOnUiThread(() -> launchDocumentExport(id, export));
            } catch (Exception | OutOfMemoryError failure) {
                if (stage != null) stage.delete();
                String error = failure instanceof IOException && failure.getMessage() != null
                        ? failure.getMessage() : "手机原图已无法读取，仍可导出小预览和参数。";
                runOnUiThread(() -> finishOnlineGallerySave(id, null, error));
            }
        });
    }

    private static void copyGalleryOriginal(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[32768];
        int total = 0;
        for (int count; (count = input.read(buffer)) != -1;) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("导出已取消。");
            total += count;
            if (total > ImagePrompts.MAX_INPUT) throw new IOException("单张原图超过 32 MB。");
            output.write(buffer, 0, count);
        }
        if (total == 0) throw new IOException("原图为空，无法导出。");
    }

    private void launchDocumentExport(int id, OnlinePacks.Export export) {
        galleryOperation = false;
        if (web == null || isFinishing()) {
            export.file.delete();
            return;
        }
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(export.mime).putExtra(Intent.EXTRA_TITLE, export.name);
        try {
            startActivityForResult(save, PICK_ONLINE_EXPORT);
            onlineExport = export;
            picker = PICK_ONLINE_EXPORT;
            pickerRequest = id;
        } catch (RuntimeException failure) {
            export.file.delete();
            send(id, null, "无法打开安卓文件保存窗口。");
        }
    }

    private void deleteGalleryImage(int id, String entryId) {
        galleryOperation = true;
        files.execute(() -> {
            try {
                boolean deleted = gallery.delete(entryId);
                runOnUiThread(() -> {
                    galleryOperation = false;
                    send(id, deleted, null);
                });
            } catch (Exception failure) {
                String message = failure instanceof IOException && failure.getMessage() != null
                        ? failure.getMessage() : "无法从图库删除这个条目，请重试。";
                runOnUiThread(() -> {
                    galleryOperation = false;
                    send(id, null, message);
                });
            }
        });
    }

    private void saveLastOriginal(int id) {
        Uri uri = imagePrompts.lastOriginal();
        JSONObject summary = imagePrompts.lastSummary();
        if (uri == null) {
            send(id, null, "请先选择一张原图。");
            return;
        }
        galleryOperation = true;
        files.execute(() -> {
            try {
                JSONObject saved = gallery.save(uri);
                if (summary != null) {
                    try {
                        saved.put("promptCached", gallery.savePrompt(saved.getString("id"), summary));
                    } catch (Exception ignored) {
                        // The preview is saved even if generation info exceeds the cache limit.
                    }
                }
                runOnUiThread(() -> {
                    galleryOperation = false;
                    send(id, saved, null);
                });
            } catch (Exception failure) {
                String message = galleryImportError(failure);
                runOnUiThread(() -> {
                    galleryOperation = false;
                    send(id, null, message);
                });
            }
        });
    }

    private void finishRemotePack(int id, Object value, String error) {
        remotePackImport = false;
        send(id, value, error);
    }

    private void packProgress(int progress) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.PocketProgress && window.PocketProgress(" + progress + ")", null);
        });
    }

    private void choose(int id, int operation, String type) {
        if (fileOperationBusy()) {
            send(id, null, "已有文件选择或导入正在进行。");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        if (operation == PICK_GALLERY) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, operation);
        picker = operation;
        pickerRequest = id;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (backup.handleActivityResult(code, result, data) || imagePrompts.handleActivityResult(code, result, data)) return;
        if (picker != code) return;
        int id = pickerRequest;
        if (code == PICK_ONLINE_EXPORT) {
            finishOnlineExport(id, result == RESULT_OK && data != null ? data.getData() : null);
            return;
        }
        if (code == PICK_GALLERY) {
            if (result != RESULT_OK || data == null) finishGalleryImport(id, null, null);
            else importGallery(id, data);
            return;
        }
        Uri uri = data == null ? null : data.getData();
        if (result != RESULT_OK || uri == null || !"content".equals(uri.getScheme())) {
            picker = 0;
            send(id, null, null);
            return;
        }
        if (code == PICK_SHARED_STYLE) {
            files.execute(() -> {
                try {
                    JSONObject catalog = sharedStyles.mount(uri);
                    runOnUiThread(() -> { picker = 0; send(id, catalog, null); });
                } catch (Exception failure) {
                    runOnUiThread(() -> { picker = 0; send(id, null, sharedStyleError(failure)); });
                }
            });
            return;
        }
        files.execute(() -> {
            Object value = null;
            String error = null;
            try {
                if (code == PICK_IMAGE) value = imageData(uri);
                else value = importPack(uri);
            } catch (Exception failure) {
                error = code == PICK_IMAGE ? "无法读取这张图片，请换一张。"
                        : failure instanceof IOException && failure.getMessage() != null ? failure.getMessage() : "无法读取所选文件，请从手机存储中重新选择。";
            }
            Object completed = value;
            String message = error;
            runOnUiThread(() -> {
                picker = 0;
                send(id, completed, message);
            });
        });
    }

    private void importGallery(int id, Intent data) {
        ClipData chosen = data.getClipData();
        List<Uri> images = new ArrayList<>();
        if (chosen != null) {
            if (chosen.getItemCount() > GALLERY_BATCH_LIMIT) {
                finishGalleryImport(id, null, "单次最多导入 40 张原图，请分批选择。");
                return;
            }
            for (int i = 0; i < chosen.getItemCount(); i++) images.add(chosen.getItemAt(i).getUri());
        } else if (data.getData() != null) {
            images.add(data.getData());
        }
        if (images.isEmpty()) {
            finishGalleryImport(id, null, null);
            return;
        }
        files.execute(() -> {
            int added = 0;
            int duplicates = 0;
            int failed = 0;
            String problem = null;
            for (Uri image : images) {
                if (Thread.currentThread().isInterrupted()) return;
                try {
                    if (gallery.save(image).optBoolean("added")) added++;
                    else duplicates++;
                } catch (Exception failure) {
                    failed++;
                    if (problem == null) problem = galleryImportError(failure);
                }
            }
            if (added + duplicates == 0) {
                String error = problem;
                runOnUiThread(() -> finishGalleryImport(id, null, error));
                return;
            }
            try {
                JSONObject summary = new JSONObject().put("added", added).put("skipped", duplicates + failed)
                        .put("duplicates", duplicates).put("failed", failed).put("message", problem);
                runOnUiThread(() -> finishGalleryImport(id, summary, null));
            } catch (org.json.JSONException failure) {
                runOnUiThread(() -> finishGalleryImport(id, null, "无法读取导入结果，请刷新图库。"));
            }
        });
    }

    private void finishGalleryImport(int id, Object value, String error) {
        picker = 0;
        send(id, value, error);
    }

    private static String galleryImportError(Exception failure) {
        return failure instanceof IOException && failure.getMessage() != null
                ? failure.getMessage() : "无法读取所选原图，请从手机文件中重新选择。";
    }

    private static String sharedStyleError(Exception failure) {
        return failure instanceof IOException && failure.getMessage() != null
                ? failure.getMessage() : "无法读取社区画风图包，请确认 ZIP 格式并重新选择。";
    }

    private JSONObject importPack(Uri uri) throws Exception {
        boolean alreadyGranted = getContentResolver().getPersistedUriPermissions().stream()
                .anyMatch(permission -> permission.isReadPermission() && uri.equals(permission.getUri()));
        getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            JSONObject imported = packs.index(uri, this::packProgress);
            if ("zip".equals(imported.optString("format")) && !alreadyGranted) {
                try { getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                catch (SecurityException ignored) {}
            }
            return imported;
        } catch (Exception failure) {
            if (!alreadyGranted) {
                try { getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                catch (SecurityException ignored) {}
            }
            throw failure;
        }
    }

    private String imageData(Uri uri) throws IOException {
        ImageDecoder.Source source = ImageDecoder.createSource(getContentResolver(), uri);
        Bitmap bitmap = ImageDecoder.decodeBitmap(source, (decoder, info, ignored) -> {
            int width = info.getSize().getWidth();
            int height = info.getSize().getHeight();
            double scale = Math.min(1, 1000.0 / Math.max(width, height));
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            decoder.setTargetSize(Math.max(1, (int) (width * scale)), Math.max(1, (int) (height * scale)));
        });
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            for (int quality : new int[] { 85, 68, 50 }) {
                output.reset();
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)) throw new IOException("Image encoding failed");
                if (output.size() <= 320000) {
                    return "data:image/jpeg;base64," + android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP);
                }
            }
            throw new IOException("Image too large");
        } finally {
            bitmap.recycle();
        }
    }

    private void send(int id, Object value, String error) {
        if (web == null) return;
        String payload = value == null ? "null" : value instanceof String ? JSONObject.quote((String) value) : value.toString();
        String problem = error == null ? "null" : JSONObject.quote(error);
        web.evaluateJavascript("window.PocketResult && window.PocketResult(" + id + "," + payload + "," + problem + ")", null);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("Boolean(window.PocketBack && window.PocketBack())", (handled) -> {
            if (!"true".equals(handled) && !isFinishing()) super.onBackPressed();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.PocketForeground && window.PocketForeground()", null);
    }

    @Override
    protected void onDestroy() {
        files.shutdownNow();
        if (onlineExport != null) onlineExport.file.delete();
        cleanupOnlineGalleryTemp(onlineGalleryTemp);
        updateChecks.shutdownNow();
        if (backup != null) backup.cancelOnDestroy();
        if (imagePrompts != null) imagePrompts.cancelOnDestroy();
        if (web != null) {
            web.removeJavascriptInterface("Pocket");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
