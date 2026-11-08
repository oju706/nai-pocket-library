package app.nai.pocketlibrary;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Indexes the style-test format published alongside NAImakeArtistGroup archives. */
final class SharedStyleTestCatalog {
    private static final int MAX_CATALOG = 4 * 1024 * 1024;
    private static final int MAX_ORIGINAL = 12 * 1024 * 1024;
    private static final int MAX_THUMBNAIL = 512 * 1024;
    private static final int MAX_ITEMS = 10000;
    private static final String SOURCE_PREFIX = "https://arca.live/b/aiart/";

    final String title;
    final String revision;
    final List<Item> items;

    private SharedStyleTestCatalog(String title, String revision, List<Item> items) {
        this.title = title;
        this.revision = revision;
        this.items = Collections.unmodifiableList(items);
    }

    static SharedStyleTestCatalog read(SharedStyleZip archive, SharedStyleZip.Source source)
            throws IOException, JSONException {
        if (archive == null || source == null) throw new IOException("无法读取画风测试图包。");
        SharedStyleZip.Entry batchEntry = archive.get("batch.json");
        if (batchEntry == null) throw new IOException("ZIP 中没有画风测试目录。");

        byte[] raw = archive.read(source, batchEntry, MAX_CATALOG);
        String revision = OnlinePacks.hex(OnlinePacks.sha256().digest(raw));
        JSONObject root = new JSONObject(new String(raw, StandardCharsets.UTF_8));
        String title = root.optString("name", "");
        String origin = root.optString("origin", "");
        JSONArray rows = root.optJSONArray("items");
        if (!"shared".equals(root.optString("library")) || title.trim().isEmpty() || title.length() > 120
                || !origin.startsWith("shared_") || rows == null
                || rows.length() < 1 || rows.length() > MAX_ITEMS) {
            throw new IOException("请选择 NAImakeArtistGroup 的画风测试 ZIP。");
        }

        List<Item> items = new ArrayList<>(rows.length());
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) throw invalidItem(i);
            String id = row.optString("style_id", "");
            String format = row.optString("output_format", "");
            JSONObject style = row.optJSONObject("style");
            JSONObject payload = row.optJSONObject("payload");
            if (!"completed".equals(row.optString("status"))
                    || !id.matches("[A-Za-z0-9_-]{1,64}") || !ids.add(id)
                    || !("webp".equals(format) || "png".equals(format))
                    || style == null || payload == null) {
                throw invalidItem(i);
            }

            String itemTitle = style.optString("name", "");
            String itemSource = style.optString("source_url", "");
            String model = payload.optString("model", "");
            if (itemTitle.trim().isEmpty() || itemTitle.length() > 200 || model.trim().isEmpty() || model.length() > 80) {
                throw invalidItem(i);
            }
            if (!itemSource.startsWith(SOURCE_PREFIX)
                    || !itemSource.substring(SOURCE_PREFIX.length()).matches("[0-9]{1,16}")) itemSource = "";

            SharedStyleZip.Entry original = archive.get(id + "." + format);
            if (original == null || original.bytes < 1 || original.bytes > MAX_ORIGINAL) {
                throw invalidItem(i);
            }
            SharedStyleZip.Entry thumbnail = archive.get(id + ".jpg");
            if (thumbnail != null && (thumbnail.bytes < 1 || thumbnail.bytes > MAX_THUMBNAIL)) thumbnail = null;
            items.add(new Item(id, itemTitle, model, itemSource,
                    "webp".equals(format) ? "image/webp" : "image/png", original, thumbnail));
        }
        return new SharedStyleTestCatalog(title, revision, items);
    }

    private static IOException invalidItem(int index) {
        return new IOException("画风测试图包第 " + (index + 1) + " 项与目录不符。");
    }

    static final class Item {
        final String id;
        final String title;
        final String model;
        final String source;
        final String mime;
        final SharedStyleZip.Entry original;
        final SharedStyleZip.Entry thumbnail;

        Item(String id, String title, String model, String source, String mime,
             SharedStyleZip.Entry original, SharedStyleZip.Entry thumbnail) {
            this.id = id;
            this.title = title;
            this.model = model;
            this.source = source;
            this.mime = mime;
            this.original = original;
            this.thumbnail = thumbnail;
        }
    }
}
