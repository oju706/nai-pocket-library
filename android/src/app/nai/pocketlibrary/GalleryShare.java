package app.nai.pocketlibrary;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;

/** Builds a self-contained, offline gallery export without exposing gallery fields as HTML. */
final class GalleryShare {
    private static final int MAX_JSON_BYTES = 16 * 1024 * 1024;
    private static final String EXPORT_PREFIX = "pocket-online-export-";
    private static final String COPY_SCRIPT =
            "(function () {\n"
            + "  'use strict';\n"
            + "  var manual = '复制失败，请手动长按文本选择并复制';\n"
            + "  function report(button, message) {\n"
            + "    var status = button.parentNode.querySelector('.copy-status');\n"
            + "    if (!status) return;\n"
            + "    status.textContent = message;\n"
            + "    if (status.resetTimer) clearTimeout(status.resetTimer);\n"
            + "    status.resetTimer = setTimeout(function () { status.textContent = ''; }, 5000);\n"
            + "  }\n"
            + "  function selectAndCopy(field) {\n"
            + "    var collapsed = field.closest('details:not([open])');\n"
            + "    if (collapsed) collapsed.open = true;\n"
            + "    var start = field.selectionStart;\n"
            + "    var end = field.selectionEnd;\n"
            + "    var copied = false;\n"
            + "    field.focus();\n"
            + "    field.select();\n"
            + "    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }\n"
            + "    if (copied) {\n"
            + "      try { field.setSelectionRange(start, end); } catch (error) {}\n"
            + "      if (collapsed) collapsed.open = false;\n"
            + "    }\n"
            + "    return copied;\n"
            + "  }\n"
            + "  function copyField(field) {\n"
            + "    try {\n"
            + "      if (navigator.clipboard && navigator.clipboard.writeText) {\n"
            + "        return navigator.clipboard.writeText(field.value).then(function () {\n"
            + "          return true;\n"
            + "        }, function () {\n"
            + "          return selectAndCopy(field);\n"
            + "        });\n"
            + "      }\n"
            + "    } catch (error) {}\n"
            + "    return Promise.resolve(selectAndCopy(field));\n"
            + "  }\n"
            + "  Array.prototype.forEach.call(document.querySelectorAll('button[data-copy]'),"
            + " function (button) {\n"
            + "    button.addEventListener('click', function () {\n"
            + "      var field = button.closest('.field').querySelector('textarea');\n"
            + "      if (!field) { report(button, manual); return; }\n"
            + "      copyField(field).then(function (copied) {\n"
            + "        report(button, copied ? '已复制' : manual);\n"
            + "      }, function () { report(button, manual); });\n"
            + "    });\n"
            + "  });\n"
            + "})();";
    private static final String COPY_SCRIPT_HASH = sha256(COPY_SCRIPT);
    private static final String[] COMMON_PARAMETER_KEYS = {
            "model", "sampler", "steps", "seed", "width", "height", "scale",
            "cfg_rescale", "noise_schedule", "strength", "noise", "uncond_scale",
            "sm", "sm_dyn", "qualityToggle", "dynamic_thresholding", "ucPreset",
            "n_samples", "denoise_strength"
    };

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
                                  JSONObject generationInfo) throws IOException, JSONException {
        boolean available = generationInfo != null;
        String title = escape(photo.optString("name", "图库图片"));
        String summary = available
                ? "小预览与图库保存的生成信息。各文本均可单独复制，完整 JSON 默认折叠。"
                : "仅包含图库小预览。当前条目没有可导出的生成信息，未用推测内容补全。";
        String status = available ? "生成信息：已保存" : "生成信息：未保存";
        String data = "data:image/jpeg;base64," + Base64.encodeToString(preview, Base64.NO_WRAP);
        output.write("<!doctype html>\n"
                + "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
                + "<meta http-equiv=\"Content-Security-Policy\" "
                + "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; "
                + "script-src '" + COPY_SCRIPT_HASH + "'; base-uri 'none'; form-action 'none'; "
                + "object-src 'none'\">"
                + "<title>" + title + " · 图库导出</title>"
                + "<style>"
                + ":root{color-scheme:light;font-family:system-ui,-apple-system,\"Noto Sans SC\",sans-serif;"
                + "background:#f4f1e9;color:#24231f}*{box-sizing:border-box}"
                + "body{margin:0;line-height:1.5}"
                + ".layout{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;max-width:1180px;"
                + "margin:0 auto;padding:16px}.media,.content{min-width:0}"
                + ".preview{display:block;width:100%;max-width:100%;max-height:48vh;"
                + "object-fit:contain;margin:0 auto;border-radius:16px;background:#fff;"
                + "box-shadow:0 12px 42px #3d37251f}"
                + ".hero{padding:2px 2px 0}.eyebrow{margin:0 0 6px;color:#756f61;font-size:13px}"
                + "h1{font-size:clamp(25px,6vw,42px);line-height:1.2;overflow-wrap:anywhere;"
                + "word-break:break-word;margin:0 0 12px}.meta{display:flex;flex-wrap:wrap;gap:8px;"
                + "margin:0 0 12px}.pill{display:inline-block;max-width:100%;padding:4px 9px;"
                + "border-radius:999px;background:#e7e1d4;color:#514b40;font-size:12px;"
                + "overflow-wrap:anywhere}.note{margin:8px 0;color:#5d584d;line-height:1.55;"
                + "overflow-wrap:anywhere}.source{margin:14px 0 0;padding:12px 14px;"
                + "border-left:3px solid #b8aa8c;background:#faf8f3;border-radius:0 10px 10px 0;"
                + "overflow-wrap:anywhere}.source strong{display:block;margin-bottom:4px;font-size:12px;"
                + "color:#756f61}.source p{margin:3px 0}.card{min-width:0;margin-top:16px;padding:16px;"
                + "border:1px solid #ddd6c8;border-radius:14px;background:#fffdf9;"
                + "box-shadow:0 5px 18px #4f46320a}.card>h2,.field h3,.role h3{margin:0;font-size:16px;"
                + "line-height:1.35;overflow-wrap:anywhere}.field-head{display:flex;align-items:center;"
                + "flex-wrap:wrap;justify-content:space-between;gap:8px;margin-bottom:10px}.tools{display:flex;"
                + "align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap;min-width:0}"
                + ".copy-status{color:#6c6558;font-size:12px;text-align:right;overflow-wrap:anywhere}"
                + "button{flex:none;min-height:44px;padding:7px 12px;border:0;border-radius:9px;background:#365981;"
                + "color:#fff;font:600 13px/1.2 system-ui,-apple-system,sans-serif;cursor:pointer}"
                + "button:active{transform:translateY(1px)}textarea{display:block;width:100%;max-width:100%;"
                + "min-height:4.5em;max-height:34vh;field-sizing:content;padding:12px;border:1px solid #d8d3c6;border-radius:10px;"
                + "background:#fbfaf7;color:#26231d;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;"
                + "white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;resize:vertical}"
                + ".role{padding-top:14px;margin-top:14px;border-top:1px solid #ece6da}.role h3{margin-bottom:10px}"
                + ".field+.field{margin-top:12px}.raw-json{cursor:default}"
                + ".parameter-list{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);"
                + "gap:0;margin:0 0 10px;font-size:13px;overflow-wrap:anywhere}"
                + ".parameter-list dt,.parameter-list dd{margin:0;padding:7px 8px;border-bottom:1px solid #ece6da}"
                + ".parameter-list dt{font-weight:600;background:#f1f3f6}"
                + ".parameter-text summary{margin-bottom:8px;cursor:pointer}"
                + ".raw-json summary{display:flex;align-items:center;justify-content:space-between;"
                + "gap:12px;cursor:pointer;font-weight:700;overflow-wrap:anywhere}"
                + ".raw-json .hint{color:#756f61;font-size:12px;font-weight:400}"
                + ".raw-json .field{margin-top:14px}.raw-json textarea{height:220px;max-height:42vh}"
                + "@media(min-width:800px){.layout{grid-template-columns:minmax(280px,.9fr) minmax(0,1.35fr);"
                + "gap:28px;padding:28px;align-items:start}.media{position:sticky;top:24px}"
                + ".preview{max-height:62vh}.card{margin-top:18px;padding:18px}"
                + "textarea{max-height:38vh}}"
                + "</style></head><body><main class=\"layout\"><div class=\"media\">"
                + "<img class=\"preview\" src=\"" + data + "\" alt=\"图库小预览\">"
                + "</div><div class=\"content\"><header class=\"hero\">"
                + "<p class=\"eyebrow\">NAI 口袋词库 · 离线图库导出</p>"
                + "<h1>" + title + "</h1>"
                + "<div class=\"meta\"><span class=\"pill\">" + escape(photo.optString("format", "图片"))
                + "</span><span class=\"pill\">" + status + "</span></div>"
                + "<p class=\"note\">" + escape(summary) + "</p>");
        String source = photo.optString("source");
        String sourcePage = photo.optString("sourcePage");
        output.write("<div class=\"source\"><strong>来源</strong>");
        if (source.isEmpty() && sourcePage.isEmpty()) {
            output.write("<p>图库未记录来源。</p>");
        } else {
            if (!source.isEmpty()) output.write("<p>" + escape(source) + "</p>");
            if (!sourcePage.isEmpty()) output.write("<p>" + escape(sourcePage) + "</p>");
        }
        output.write("</div></header>");
        if (available) {
            String missing = generationInfo.optString("missingReason");
            if (!missing.isEmpty()) output.write("<p class=\"card note\">" + escape(missing) + "</p>");
            String prompt = stringValue(generationInfo, "prompt");
            String negativePrompt = stringValue(generationInfo, "negativePrompt");
            String actualPrompt = stringValue(generationInfo, "actualPrompt");
            String actualNegativePrompt = stringValue(generationInfo, "actualNegativePrompt");
            if (!prompt.isEmpty()) writeCardField(output, "正向提示词", prompt);
            if (!negativePrompt.isEmpty()) writeCardField(output, "负向提示词", negativePrompt);
            if (!actualPrompt.isEmpty() && !actualPrompt.equals(prompt)) {
                writeCardField(output, "实际正向提示词", actualPrompt);
            }
            if (!actualNegativePrompt.isEmpty() && !actualNegativePrompt.equals(negativePrompt)) {
                writeCardField(output, "实际负向提示词", actualNegativePrompt);
            }

            JSONArray characters = jsonArray(generationInfo, "characters");
            JSONArray negativeCharacters = jsonArray(generationInfo, "negativeCharacters");
            writeCharacters(output, "逐角色提示词", characters, negativeCharacters);
            JSONArray actualCharacters = jsonArray(generationInfo, "actualCharacters");
            JSONArray actualNegativeCharacters = jsonArray(generationInfo, "actualNegativeCharacters");
            if (!sameJson(characters, actualCharacters)
                    || !sameJson(negativeCharacters, actualNegativeCharacters)) {
                writeCharacters(output, "实际逐角色提示词", actualCharacters, actualNegativeCharacters);
            }

            JSONObject parameters = collectParameters(generationInfo);
            if (parameters.length() > 0) writeParameterCard(output, parameters);
        }
        output.write("<details class=\"card raw-json\"><summary><span>完整生成信息 JSON</span>"
                + "<span class=\"hint\">默认折叠</span></summary><div class=\"field\"><div class=\"field-head\">"
                + "<h3>完整 JSON</h3><div class=\"tools\"><span class=\"copy-status\" aria-live=\"polite\"></span>"
                + "<button type=\"button\" data-copy>复制</button></div></div>"
                + "<textarea readonly spellcheck=\"false\" wrap=\"soft\" aria-label=\"完整生成信息 JSON\">\n");
        writeEscaped(output, json);
        output.write("</textarea></div></details></div></main><script>"
                + COPY_SCRIPT + "</script></body></html>");
    }

    private static void writeCardField(Writer output, String label, String text) throws IOException {
        output.write("<section class=\"card\">");
        writeCopyField(output, label, text);
        output.write("</section>");
    }

    private static void writeCopyField(Writer output, String label, String text) throws IOException {
        output.write("<div class=\"field\"><div class=\"field-head\"><h3>" + escape(label)
                + "</h3><div class=\"tools\"><span class=\"copy-status\" aria-live=\"polite\"></span>"
                + "<button type=\"button\" data-copy>复制</button></div></div>"
                + "<textarea readonly rows=\"4\" spellcheck=\"false\" wrap=\"soft\" aria-label=\""
                + escape(label) + "\">\n");
        writeEscaped(output, text);
        output.write("</textarea></div>");
    }

    private static void writeCharacters(Writer output, String heading, JSONArray positive,
                                        JSONArray negative) throws IOException {
        int count = Math.max(positive.length(), negative.length());
        boolean sectionStarted = false;
        for (int index = 0; index < count; index++) {
            String positiveText = characterCaption(positive.opt(index));
            String negativeText = characterCaption(negative.opt(index));
            if (positiveText.isEmpty() && negativeText.isEmpty()) continue;
            if (!sectionStarted) {
                output.write("<section class=\"card\"><h2>" + escape(heading) + "</h2>");
                sectionStarted = true;
            }
            output.write("<div class=\"role\"><h3>角色 " + (index + 1) + "</h3>");
            if (!positiveText.isEmpty()) writeCopyField(output, "正向提示词", positiveText);
            if (!negativeText.isEmpty()) writeCopyField(output, "负向提示词", negativeText);
            output.write("</div>");
        }
        if (sectionStarted) output.write("</section>");
    }

    private static void writeParameterCard(Writer output, JSONObject parameters) throws IOException, JSONException {
        output.write("<section class=\"card field\"><div class=\"field-head\"><h3>生成参数</h3>"
                + "<div class=\"tools\"><span class=\"copy-status\" aria-live=\"polite\"></span>"
                + "<button type=\"button\" data-copy>复制参数</button></div></div><dl class=\"parameter-list\">");
        Iterator<String> keys = parameters.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            output.write("<dt>" + escape(parameterLabel(key)) + "</dt><dd>");
            writeEscaped(output, parameters.optString(key));
            output.write("</dd>");
        }
        output.write("</dl><details class=\"parameter-text\"><summary>查看参数文本</summary>"
                + "<textarea readonly rows=\"4\" spellcheck=\"false\" wrap=\"soft\" aria-label=\"生成参数\">\n");
        writeEscaped(output, parameters.toString(2));
        output.write("</textarea></details></section>");
    }

    private static String parameterLabel(String key) {
        switch (key) {
            case "model": return "模型";
            case "sampler": return "采样器";
            case "steps": return "步数";
            case "seed": return "种子";
            case "width": return "宽度";
            case "height": return "高度";
            default: return key;
        }
    }

    private static String characterCaption(Object item) {
        if (item instanceof String) return (String)item;
        if (!(item instanceof JSONObject)) return "";
        JSONObject character = (JSONObject)item;
        String caption = stringValue(character, "char_caption");
        if (caption.isEmpty()) caption = stringValue(character, "caption");
        if (caption.isEmpty()) caption = stringValue(character, "prompt");
        return caption;
    }

    private static JSONArray jsonArray(JSONObject source, String key) {
        JSONArray array = source.optJSONArray(key);
        return array == null ? new JSONArray() : array;
    }

    private static boolean sameJson(JSONArray left, JSONArray right) {
        return left.toString().equals(right.toString());
    }

    private static String stringValue(JSONObject source, String key) {
        Object value = source.opt(key);
        return value instanceof String ? (String)value : "";
    }

    private static JSONObject collectParameters(JSONObject generationInfo) {
        JSONObject result = new JSONObject();
        JSONObject parameters = generationInfo.optJSONObject("parameters");
        for (String key : COMMON_PARAMETER_KEYS) {
            putScalar(result, parameters, key);
            putScalar(result, generationInfo, key);
        }
        if (parameters != null) {
            Iterator<String> keys = parameters.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!isPromptStructure(key)) putScalar(result, parameters, key);
            }
        }
        return result;
    }

    private static void putScalar(JSONObject target, JSONObject source, String key) {
        if (source == null || target.has(key)) return;
        Object value = source.opt(key);
        if (value == null || value == JSONObject.NULL || value instanceof JSONObject
                || value instanceof JSONArray) {
            return;
        }
        try {
            target.put(key, value);
        } catch (JSONException ignored) {
            // A malformed optional field is omitted; the full JSON remains available below.
        }
    }

    private static boolean isPromptStructure(String key) {
        switch (key) {
            case "prompt":
            case "uc":
            case "negative_prompt":
            case "actual_prompts":
            case "v4_prompt":
            case "v4_negative_prompt":
                return true;
            default:
                return false;
        }
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return "sha256-" + Base64.encodeToString(digest, Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
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
