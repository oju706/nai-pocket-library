package app.nai.pocketlibrary;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/** Shares only the verified update APK with Android's package installer. */
public final class UpdateFileProvider extends ContentProvider {
    static final String NAME = "NAI-Pocket-Library.apk";
    static final String MIME = "application/vnd.android.package-archive";

    static File updateFile(Context context) {
        return new File(new File(context.getCacheDir(), "app-update"), NAME);
    }

    static Uri updateUri(Context context) {
        return Uri.parse("content://" + context.getPackageName() + ".updates/" + NAME);
    }

    @Override public boolean onCreate() { return true; }

    private File file(Uri uri) {
        Context context = getContext();
        if (context == null || !updateUri(context).equals(uri)) throw new IllegalArgumentException("Unknown update file");
        return updateFile(context);
    }

    @Override public String getType(Uri uri) { file(uri); return MIME; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Update file is read-only");
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File apk = file(uri);
        String[] columns = projection == null ? new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : columns) {
            row.add(OpenableColumns.DISPLAY_NAME.equals(column) ? NAME : OpenableColumns.SIZE.equals(column) ? apk.length() : null);
        }
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
