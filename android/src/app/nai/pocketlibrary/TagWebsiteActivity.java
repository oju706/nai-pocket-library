package app.nai.pocketlibrary;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Collections;
import java.util.Locale;

public final class TagWebsiteActivity extends Activity {
    public static final String EXTRA_URL = "url";

    private static final String DANBOORU_HOST = "danbooru.donmai.us";
    private static final String GELBOORU_HOST = "gelbooru.com";
    private static final int PAPER = Color.rgb(246, 244, 237);
    private static final int INK = Color.rgb(43, 40, 36);
    private static final int MUTED = Color.rgb(112, 105, 96);

    private WebView web;
    private FrameLayout content;
    private LinearLayout errorPanel;
    private TextView siteNameView;
    private TextView hostView;
    private TextView errorTitle;
    private TextView errorMessage;
    private Button retryButton;
    private Button errorBrowserButton;
    private TextView browserAction;

    private Uri currentSite;
    private Uri retryTarget;
    private Uri errorBrowserTarget;

    public static boolean allows(Uri uri) {
        return uri != null && allowsUrl(uri.toString());
    }

    static boolean allowsUrl(String value) {
        try {
            URI url = new URI(value);
            if (!"https".equalsIgnoreCase(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null) return false;
            String host = url.getHost().toLowerCase(Locale.ROOT);
            String authority = url.getRawAuthority();
            return (DANBOORU_HOST.equals(host) || GELBOORU_HOST.equals(host))
                    && (host.equalsIgnoreCase(authority) || (host + ":443").equalsIgnoreCase(authority));
        } catch (URISyntaxException invalid) {
            return false;
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();
        buildUi();
        configureWebView();

        String rawUrl = getIntent().getStringExtra(EXTRA_URL);
        Uri start = TextUtils.isEmpty(rawUrl) ? null : Uri.parse(rawUrl);
        if (allows(start)) {
            loadSite(start);
        } else {
            updateSiteIdentity(null);
            showError("无法打开该网站",
                    "仅支持 Danbooru 与 Gelbooru 的 HTTPS 官网地址。",
                    null, null);
        }
    }

    private void configureWindow() {
        getWindow().setStatusBarColor(PAPER);
        getWindow().setNavigationBarColor(PAPER);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        }
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(PAPER);

        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setMinimumHeight(dp(56));
        topBar.setPadding(dp(4), 0, dp(4), 0);
        topBar.setBackgroundColor(PAPER);
        topBar.setElevation(dp(2));
        root.addView(topBar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView back = makeTopAction("返回", "返回网页或关闭");
        back.setOnClickListener(view -> navigateBackOrFinish());
        topBar.addView(back);

        LinearLayout titleBlock = new LinearLayout(this);
        titleBlock.setOrientation(LinearLayout.VERTICAL);
        titleBlock.setGravity(Gravity.CENTER_VERTICAL);
        titleBlock.setPadding(dp(6), 0, dp(6), 0);
        siteNameView = new TextView(this);
        siteNameView.setText("Tag 网站");
        siteNameView.setTextColor(INK);
        siteNameView.setTextSize(17);
        siteNameView.setTypeface(Typeface.DEFAULT_BOLD);
        siteNameView.setSingleLine(true);
        siteNameView.setEllipsize(TextUtils.TruncateAt.END);
        titleBlock.addView(siteNameView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        hostView = new TextView(this);
        hostView.setTextColor(MUTED);
        hostView.setTextSize(11);
        hostView.setSingleLine(true);
        hostView.setEllipsize(TextUtils.TruncateAt.END);
        titleBlock.addView(hostView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        topBar.addView(titleBlock, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        browserAction = makeTopAction("浏览器", "在系统浏览器中打开当前官网");
        browserAction.setOnClickListener(view -> {
            if (currentSite == null) {
                Toast.makeText(this, "当前没有可打开的官网地址", Toast.LENGTH_SHORT).show();
                return;
            }
            openInBrowser(currentSite);
        });
        topBar.addView(browserAction);

        TextView close = makeTopAction("关闭", "关闭网页");
        close.setOnClickListener(view -> finish());
        topBar.addView(close);

        content = new FrameLayout(this);
        content.setBackgroundColor(PAPER);
        root.addView(content, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        content.addView(buildErrorPanel(), new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private View buildErrorPanel() {
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setBackgroundColor(PAPER);
        errorPanel.setVisibility(View.GONE);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        errorPanel.addView(scroll, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        LinearLayout message = new LinearLayout(this);
        message.setOrientation(LinearLayout.VERTICAL);
        message.setGravity(Gravity.CENTER_HORIZONTAL);
        message.setPadding(dp(28), dp(36), dp(28), dp(36));
        scroll.addView(message, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));

        errorTitle = new TextView(this);
        errorTitle.setTextColor(INK);
        errorTitle.setTextSize(23);
        errorTitle.setGravity(Gravity.CENTER);
        errorTitle.setTypeface(Typeface.DEFAULT_BOLD);
        message.addView(errorTitle, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        errorMessage = new TextView(this);
        errorMessage.setTextColor(MUTED);
        errorMessage.setTextSize(15);
        errorMessage.setGravity(Gravity.CENTER);
        errorMessage.setLineSpacing(dp(3), 1f);
        errorMessage.setTextIsSelectable(true);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        detailParams.topMargin = dp(14);
        message.addView(errorMessage, detailParams);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        actionParams.topMargin = dp(24);
        message.addView(actions, actionParams);

        retryButton = new Button(this);
        retryButton.setText("重试");
        retryButton.setOnClickListener(view -> {
            if (retryTarget != null && allows(retryTarget)) loadSite(retryTarget);
        });
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        actions.addView(retryButton, retryParams);

        errorBrowserButton = new Button(this);
        errorBrowserButton.setText("浏览器打开");
        errorBrowserButton.setOnClickListener(view -> openInBrowser(errorBrowserTarget));
        LinearLayout.LayoutParams browserParams = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        browserParams.leftMargin = dp(8);
        actions.addView(errorBrowserButton, browserParams);
        return errorPanel;
    }

    private void configureWebView() {
        web = new WebView(this);
        web.setBackgroundColor(PAPER);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        content.addView(web, 0, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(false);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new SiteClient());
    }

    private void loadSite(Uri uri) {
        if (!allows(uri)) {
            updateSiteIdentity(null);
            showError("无法打开该网站",
                    "仅支持 Danbooru 与 Gelbooru 的 HTTPS 官网地址。",
                    null, null);
            return;
        }
        currentSite = uri;
        retryTarget = uri;
        updateSiteIdentity(uri);
        hideError();
        web.loadUrl(uri.toString());
    }

    private void updateSiteIdentity(Uri uri) {
        String name = "Tag 网站";
        String host = "仅限 Danbooru / Gelbooru 官网";
        if (uri != null && uri.getHost() != null) {
            String safeHost = uri.getHost().toLowerCase(Locale.ROOT);
            if (DANBOORU_HOST.equals(safeHost)) name = "Danbooru";
            if (GELBOORU_HOST.equals(safeHost)) name = "Gelbooru";
            host = safeHost;
        }
        siteNameView.setText(name);
        hostView.setText(host);
        setTitle(name);
        browserAction.setEnabled(uri != null);
        browserAction.setAlpha(uri == null ? 0.45f : 1f);
    }

    private void showError(String title, String detail, Uri retry, Uri browserTarget) {
        web.stopLoading();
        web.setVisibility(View.GONE);
        retryTarget = retry != null && allows(retry) ? retry : null;
        errorBrowserTarget = isBrowserAddress(browserTarget) ? browserTarget : null;
        errorTitle.setText(title);
        errorMessage.setText(detail);
        retryButton.setEnabled(retryTarget != null);
        retryButton.setAlpha(retryTarget == null ? 0.45f : 1f);
        errorBrowserButton.setEnabled(errorBrowserTarget != null);
        errorBrowserButton.setAlpha(errorBrowserTarget == null ? 0.45f : 1f);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        errorPanel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
    }

    private void blockedNavigation() {
        if (currentSite == null) {
            showError("无法打开该网站", "请从图库打开 Danbooru 或 Gelbooru 官网。", null, null);
        } else {
            Toast.makeText(this, "这个链接会离开官网，已留在当前页面。", Toast.LENGTH_SHORT).show();
        }
    }

    private void networkError(WebResourceRequest request, String detail) {
        Uri failed = request == null ? null : request.getUrl();
        Uri browserTarget = isBrowserAddress(failed) ? failed : currentSite;
        showError("网页加载失败", detail, allows(failed) ? failed : currentSite, browserTarget);
    }

    private void navigateBackOrFinish() {
        if (web != null && web.canGoBack()) {
            hideError();
            web.goBack();
        } else {
            finish();
        }
    }

    private void openInBrowser(Uri uri) {
        if (!isBrowserAddress(uri)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
        }
    }

    private TextView makeTopAction(String text, String description) {
        TextView action = new TextView(this);
        action.setText(text);
        action.setTextColor(INK);
        action.setTextSize(15);
        action.setGravity(Gravity.CENTER);
        action.setMinWidth(dp(48));
        action.setMinHeight(dp(48));
        action.setPadding(dp(8), dp(10), dp(8), dp(10));
        action.setContentDescription(description);
        action.setClickable(true);
        action.setFocusable(true);
        action.setBackgroundResource(android.R.drawable.list_selector_background);
        return action;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static boolean isBrowserAddress(Uri uri) {
        return allows(uri);
    }

    @Override
    public void onBackPressed() {
        navigateBackOrFinish();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.stopLoading();
            web.setWebChromeClient(null);
            web.setWebViewClient(null);
            content.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private final class SiteClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null) return true;
            Uri uri = request.getUrl();
            if (!request.isForMainFrame()) return !"https".equalsIgnoreCase(uri.getScheme());
            if (allows(uri)) return false;
            blockedNavigation();
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!"appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())
                    && (!request.isForMainFrame() || allows(uri))) return null;
            return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
                    Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            Uri uri = url == null ? null : Uri.parse(url);
            if (!allows(uri)) {
                view.stopLoading();
                blockedNavigation();
                return;
            }
            currentSite = uri;
            retryTarget = uri;
            updateSiteIdentity(uri);
            hideError();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame()) return;
            String description = error == null || TextUtils.isEmpty(error.getDescription())
                    ? "发生网络错误" : error.getDescription().toString();
            int code = error == null ? -1 : error.getErrorCode();
            networkError(request, description + "\n\n错误代码：" + code);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceResponse response) {
            if (request == null || !request.isForMainFrame() || response == null) return;
            int status = response.getStatusCode();
            if (status < 400) return;
            showError("网页返回 HTTP 错误",
                    "服务器状态码：" + status + " " + response.getReasonPhrase()
                            + "\n\n请稍后重试，或在浏览器中检查该页面。",
                    allows(request.getUrl()) ? request.getUrl() : currentSite,
                    request.getUrl());
        }
    }
}
