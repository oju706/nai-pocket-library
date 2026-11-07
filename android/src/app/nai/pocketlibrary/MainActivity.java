package app.nai.pocketlibrary;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
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

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
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
    private static final int COPY_LIMIT = 256 * 1024;
    private static final int PAPER = Color.rgb(246, 244, 237);
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private int picker;
    private int pickerRequest;
    private WebView web;
    private NaxLibrary nax;
    private KoreanLibrary korean;
    private LocalPacks packs;
    private AppUpdates updates;
    private LibraryBackup backup;
    private ImagePrompts imagePrompts;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        nax = new NaxLibrary(this);
        korean = new KoreanLibrary(this);
        packs = new LocalPacks(this);
        updates = new AppUpdates(this);
        backup = new LibraryBackup(this, this::send);
        imagePrompts = new ImagePrompts(this, this::send);
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
            if ("/api/korean.json".equals(path)) return response("application/json", korean.openIndex(), false);
            if ("/api/korean-status.json".equals(path)) {
                byte[] status = korean.status("1".equals(url.getQueryParameter("check"))).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
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
            if (parts.size() == 3 && "korean-image".equals(parts.get(0))) {
                KoreanLibrary.Preview preview = korean.preview(Long.parseLong(parts.get(1)), Integer.parseInt(parts.get(2)));
                return response(preview.type, new ByteArrayInputStream(preview.bytes), false);
            }
            if (parts.size() == 3 && "api".equals(parts.get(0)) && "pack".equals(parts.get(1)) && parts.get(2).endsWith(".json")) {
                String file = parts.get(2);
                return response("application/json", packs.openIndex(file.substring(0, file.length() - 5)), false);
            }
            if (parts.size() == 3 && "nax-image".equals(parts.get(0))) {
                return response("image/webp", nax.openPreview(parts.get(1), parts.get(2)), true);
            }
            if (parts.size() == 4 && "pack-image".equals(parts.get(0))) {
                byte[] bytes = packs.image(parts.get(1), Long.parseLong(parts.get(2)), Integer.parseInt(parts.get(3)));
                String type = NaxLibrary.imageType(bytes);
                if (type != null) return response(type, new ByteArrayInputStream(bytes), false);
            }
        } catch (Exception ignored) {
            return unavailable();
        }
        return unavailable();
    }

    private static WebResourceResponse response(String type, InputStream content, boolean cached) {
        return new WebResourceResponse(type, type.startsWith("image/") ? null : "UTF-8", 200, "OK",
                Collections.singletonMap("Cache-Control", cached ? "private, max-age=604800" : "no-store"), content);
    }

    private static WebResourceResponse unavailable() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Unavailable",
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
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
                    if (value.length() > COPY_LIMIT || value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > COPY_LIMIT) {
                        send(id, null, "内容过大，请导出词库备份保留完整参数。");
                        return;
                    }
                    ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                    try {
                        clipboard.setPrimaryClip(ClipData.newPlainText("NovelAI 提示词", value));
                    } catch (RuntimeException failure) {
                        send(id, null, "系统未能复制这些内容，请导出词库备份保留完整参数。");
                        return;
                    }
                    send(id, true, null);
                    return;
                case "listPacks":
                    send(id, packs.list(), null);
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
                case "checkAppUpdate":
                    files.execute(() -> {
                        JSONObject result = updates.check();
                        runOnUiThread(() -> send(id, result, null));
                    });
                    return;
                case "openAppRelease":
                    startActivity(new Intent(Intent.ACTION_VIEW, updates.openTarget(value)));
                    send(id, true, null);
                    return;
                case "exportBackup":
                case "importBackup":
                case "readImagePrompts":
                    if (picker != 0 || backup.isBusy() || imagePrompts.isBusy()) {
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

    private void choose(int id, int operation, String type) {
        if (picker != 0 || backup.isBusy() || imagePrompts.isBusy()) {
            send(id, null, "已有文件选择或导入正在进行。");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
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
        Uri uri = data == null ? null : data.getData();
        if (result != RESULT_OK || uri == null || !"content".equals(uri.getScheme())) {
            picker = 0;
            send(id, null, null);
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

    private JSONObject importPack(Uri uri) throws Exception {
        boolean alreadyGranted = getContentResolver().getPersistedUriPermissions().stream()
                .anyMatch(permission -> permission.isReadPermission() && uri.equals(permission.getUri()));
        getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            return packs.index(uri, (progress) -> runOnUiThread(() -> {
                if (web != null) web.evaluateJavascript("window.PocketProgress && window.PocketProgress(" + progress + ")", null);
            }));
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
    protected void onDestroy() {
        files.shutdownNow();
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
