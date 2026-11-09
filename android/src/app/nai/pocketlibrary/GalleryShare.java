package app.nai.pocketlibrary;

import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Builds a self-contained, offline gallery export without exposing gallery fields as HTML. */
final class GalleryShare {
    private static final int MAX_JSON_BYTES = 16 * 1024 * 1024;
    private static final String EXPORT_PREFIX = "pocket-online-export-";

    private GalleryShare() {}

    static OnlinePacks.Export prepare(File cache, GalleryStore.Entry entry, byte[] preview,
                                      JSONObject generationInfo, String unavailableReason)
            throws IOException, JSONException {
        JSONObject photo = new JSONObject().put("id", entry.id).put("name", entry.name)
                .put("format", entry.format).put("createdAt", entry.createdAt)
                .put("source", entry.sourceTitle).put("sourcePage", entry.sourcePage)
                .put("storageKind", entry.previewFile != null ? "preview" : "legacy-copy");
        return prepare(cache, photo, preview, generationInfo, unavailableReason);
    }

    static OnlinePacks.Export prepare(File cache, JSONObject photo, byte[] preview,
                                      JSONObject generationInfo, String unavailableReason)
            throws IOException, JSONException {
        if (preview == null || preview.length == 0) throw new IOException("图库小预览为空，无法导出。");

        JSONObject document = new JSONObject()
                .put("format", "nai-pocket-library-gallery-export")
                .put("version", 1)
                .put("exportedAt", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT)
                        .format(new Date()))
                .put("gallery", photo)
                .put("generationInfoAvailable", generationInfo != null);
        if (generationInfo != null) {
            document.put("generationInfo", generationInfo);
        } else {
            document.put("generationInfo", JSONObject.NULL)
                    .put("note", unavailableReason == null || unavailableReason.isEmpty()
                            ? "图库中没有可导出的生成信息；小预览仍可离线查看。"
                            : unavailableReason);
        }
        String json = document.toString(2);
        if (json.getBytes(StandardCharsets.UTF_8).length > MAX_JSON_BYTES) {
            throw new IOException("图库生成信息过大，无法导出为单个 HTML。");
        }

        String stamp = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.ROOT).format(new Date());
        File stage = File.createTempFile(EXPORT_PREFIX, ".html", cache);
        boolean ready = false;
        try {
            try (Writer output = new OutputStreamWriter(new FileOutputStream(stage), StandardCharsets.UTF_8)) {
                writeHtml(output, photo, preview, json, generationInfo);
            }
            ready = true;
            return new OnlinePacks.Export(stage, "NAI-图库-" + stamp + ".html", "text/html");
        } finally {
            if (!ready) stage.delete();
        }
    }

    private static void writeHtml(Writer output, JSONObject photo, byte[] preview, String json,
                                  JSONObject generationInfo) throws IOException {
        boolean available = generationInfo != null;
        String title = escape(photo.optString("name", "图库图片"));
        String summary = available
                ? "小预览与图库保存的完整生成信息。以下 JSON 可全选复制。"
                : "仅包含图库小预览。当前条目没有可导出的生成信息，未用推测内容补全。";
        String status = available ? "生成信息：已保存" : "生成信息：未保存";
        String data = "data:image/jpeg;base64," + Base64.encodeToString(preview, Base64.NO_WRAP);
        output.write("<!doctype html>\n"
                + "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<meta http-equiv=\"Content-Security-Policy\" "
                + "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">"
                + "<title>" + title + " · 图库导出</title>"
                + "<style>"
                + ":root{color-scheme:light;font-family:system-ui,-apple-system,\"Noto Sans SC\",sans-serif;"
                + "background:#f6f4ed;color:#24231f}*{box-sizing:border-box}"
                + "body{margin:0;padding:24px}main{max-width:920px;margin:auto}"
                + "header{margin-bottom:20px}.eyebrow{margin:0 0 6px;color:#756f61;font-size:13px}"
                + "h1{font-size:clamp(24px,5vw,42px);line-height:1.2;overflow-wrap:anywhere;margin:0 0 10px}"
                + ".note{margin:8px 0;color:#5d584d;line-height:1.55}"
                + ".preview{display:block;max-width:100%;max-height:70vh;width:auto;height:auto;margin:20px auto;"
                + "border-radius:14px;box-shadow:0 12px 42px #3d37251f;background:#fff}"
                + "section{margin-top:24px}h2{font-size:17px;margin:0 0 10px}"
                + "textarea{width:100%;min-height:46vh;padding:16px;border:1px solid #d8d3c6;border-radius:12px;"
                + "background:#fff;color:#26231d;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;"
                + "white-space:pre;resize:vertical}"
                + "</style></head><body><main><header>"
                + "<p class=\"eyebrow\">NAI 口袋词库 · 离线图库导出</p>"
                + "<h1>" + title + "</h1>"
                + "<p class=\"note\">" + escape(photo.optString("format", "图片")) + " · " + status + "</p>"
                + "<p class=\"note\">" + escape(summary) + "</p></header>"
                + "<img class=\"preview\" src=\"" + data + "\" alt=\"小预览：" + title + "\">");
        String sourcePage = photo.optString("sourcePage");
        if (!sourcePage.isEmpty()) output.write("<p class=\"note\">来源：" + escape(sourcePage) + "</p>");
        if (available) {
            String missing = generationInfo.optString("missingReason");
            if (!missing.isEmpty()) output.write("<p class=\"note\">" + escape(missing) + "</p>");
            writePrompt(output, "正向提示词", generationInfo.optString("prompt"));
            writePrompt(output, "负向提示词", generationInfo.optString("negativePrompt"));
        }
        output.write("<section><h2>完整生成信息 JSON（可全选复制）</h2>"
                + "<textarea readonly spellcheck=\"false\" aria-label=\"完整生成信息 JSON\">\n");
        writeEscaped(output, json);
        output.write("</textarea></section></main></body></html>");
    }

    private static void writePrompt(Writer output, String label, String text) throws IOException {
        if (text.isEmpty()) return;
        output.write("<section><h2>" + label + "</h2><textarea readonly spellcheck=\"false\" aria-label=\"" + label + "\">\n");
        writeEscaped(output, text);
        output.write("</textarea></section>");
    }

    private static String escape(String value) {
        if (value == null) return "";
        StringBuilder escaped = new StringBuilder(value.length() + 32);
        for (int i = 0; i < value.length(); i++) {
            char letter = value.charAt(i);
            switch (letter) {
                case '&': escaped.append("&amp;"); break;
                case '<': escaped.append("&lt;"); break;
                case '>': escaped.append("&gt;"); break;
                case '"': escaped.append("&quot;"); break;
                case '\'': escaped.append("&#39;"); break;
                default: escaped.append(letter);
            }
        }
        return escaped.toString();
    }

    private static void writeEscaped(Writer output, String value) throws IOException {
        for (int start = 0; start < value.length(); start += 8192) {
            output.write(escape(value.substring(start, Math.min(start + 8192, value.length()))));
        }
    }
}
