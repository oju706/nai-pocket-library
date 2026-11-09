package app.nai.pocketlibrary;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

final class PackPhotoCache {
    private static final int MAX_IMAGE_BYTES = 12 * 1024 * 1024;
    private static final int MAX_LIMIT_MIB = 4096;
    private static final long MAX_AGE_MILLIS = 24L * 60L * 60L * 1000L;
    private static final String TEMP_PREFIX = ".pack-photo-";
    private static final String TEMP_SUFFIX = ".tmp";

    private final File directory;
    private int limitMiB;

    PackPhotoCache(File directory, int limitMiB) {
        this.directory = directory;
        this.limitMiB = normalizeLimit(limitMiB);
    }

    synchronized byte[] get(String sha, int expectedBytes) {
        if (limitMiB == 0 || !isValidSha(sha)
                || expectedBytes < 0 || expectedBytes > MAX_IMAGE_BYTES) {
            return null;
        }

        File file = cacheFile(sha);
        if (file == null) {
            return null;
        }

        byte[] result;
        try {
            if (!isOwnedRegularFile(file)) {
                return null;
            }
            if (isUnusedSince(file, System.currentTimeMillis(), MAX_AGE_MILLIS)) {
                deleteQuietly(file);
                return null;
            }
            if (file.length() != expectedBytes) {
                return null;
            }
            result = readExact(file, expectedBytes);
        } catch (IOException | SecurityException ignored) {
            return null;
        }

        if (result != null) {
            touch(file);
        }
        return result;
    }

    synchronized void put(String sha, byte[] bytes) {
        maintain(null);
        if (limitMiB == 0) {
            clear();
            return;
        }
        if (!isValidSha(sha) || bytes == null
                || bytes.length <= 0 || bytes.length > MAX_IMAGE_BYTES
                || (long) bytes.length > limitBytes()) {
            return;
        }
        if (!ensureDirectory()) {
            return;
        }

        File destination = cacheFile(sha);
        if (destination == null) {
            return;
        }
        evictToFit((long) bytes.length, sha);

        File temporary = null;
        boolean moved = false;
        try {
            temporary = File.createTempFile(TEMP_PREFIX, TEMP_SUFFIX, directory);
            FileOutputStream output = new FileOutputStream(temporary);
            try {
                output.write(bytes);
                output.flush();
                output.getFD().sync();
            } finally {
                output.close();
            }

            moveIntoPlace(temporary, destination);
            moved = true;
            touch(destination);
        } catch (IOException | SecurityException ignored) {
            // A cache miss is preferable to breaking image browsing.
        } finally {
            if (!moved && temporary != null) {
                deleteQuietly(temporary);
            }
        }

        if (moved) {
            enforceLimit(null);
        }
    }

    synchronized void setLimit(int limitMiB) {
        this.limitMiB = normalizeLimit(limitMiB);
        if (this.limitMiB == 0) {
            clear();
        } else {
            maintain(null);
        }
    }

    synchronized void clear() {
        if (!isCacheDirectory()) {
            return;
        }
        File[] files = listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (isCacheEntry(file) || isTemporaryEntry(file)) {
                deleteQuietly(file);
            }
        }
    }

    synchronized long bytes() {
        maintain(null);
        if (limitMiB == 0 || !isCacheDirectory()) {
            return 0L;
        }
        File[] files = listFiles();
        if (files == null) {
            return 0L;
        }

        long total = 0L;
        for (File file : files) {
            if (!isCacheEntry(file)) {
                continue;
            }
            try {
                long length = file.length();
                if (length > 0 && Long.MAX_VALUE - total >= length) {
                    total += length;
                }
            } catch (SecurityException ignored) {
                // Report the bytes that can be inspected.
            }
        }
        return total;
    }

    private void maintain(String protectedSha) {
        if (limitMiB == 0) {
            clear();
            return;
        }
        if (!ensureDirectory()) {
            return;
        }

        long now = System.currentTimeMillis();
        File[] files = listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            try {
                if (isTemporaryEntry(file)) {
                    if (isUnusedSince(file, now, MAX_AGE_MILLIS)) {
                        deleteQuietly(file);
                    }
                } else if (isCacheEntry(file)
                        && isUnusedSince(file, now, MAX_AGE_MILLIS)) {
                    deleteQuietly(file);
                }
            } catch (SecurityException ignored) {
                // Leave entries that cannot be inspected for this pass.
            }
        }
        enforceLimit(protectedSha);
    }

    private void enforceLimit(String protectedSha) {
        long limit = limitBytes();
        long total = 0L;
        List<Entry> entries = new ArrayList<Entry>();
        File[] files = listFiles();
        if (files == null) {
            return;
        }

        for (File file : files) {
            if (!isCacheEntry(file)) {
                continue;
            }
            try {
                long length = file.length();
                total = saturatedAdd(total, length);
                entries.add(new Entry(file, length, file.lastModified()));
            } catch (SecurityException ignored) {
                // Ignore files that disappear or become inaccessible.
            }
        }
        if (total <= limit) {
            return;
        }

        Collections.sort(entries, new Comparator<Entry>() {
            @Override
            public int compare(Entry left, Entry right) {
                int byTime = Long.compare(left.lastUsed, right.lastUsed);
                return byTime != 0 ? byTime : left.file.getName().compareTo(right.file.getName());
            }
        });
        for (Entry entry : entries) {
            if (total <= limit) {
                break;
            }
            if (entry.file.getName().equals(protectedSha)) {
                continue;
            }
            if (deleteQuietly(entry.file)) {
                total -= entry.length;
            }
        }
    }

    private void evictToFit(long newLength, String destinationSha) {
        long limit = limitBytes();
        long total = 0L;
        long destinationBytes = 0L;
        List<Entry> entries = new ArrayList<Entry>();
        File[] files = listFiles();
        if (files == null) {
            return;
        }

        for (File file : files) {
            if (!isCacheEntry(file)) {
                continue;
            }
            try {
                long length = file.length();
                total = saturatedAdd(total, length);
                if (file.getName().equals(destinationSha)) {
                    destinationBytes = length;
                } else {
                    entries.add(new Entry(file, length, file.lastModified()));
                }
            } catch (SecurityException ignored) {
                // Ignore files that disappear or become inaccessible.
            }
        }

        long projected = saturatedAdd(total - Math.min(destinationBytes, total), newLength);
        if (projected <= limit) {
            return;
        }
        Collections.sort(entries, new Comparator<Entry>() {
            @Override
            public int compare(Entry left, Entry right) {
                int byTime = Long.compare(left.lastUsed, right.lastUsed);
                return byTime != 0 ? byTime : left.file.getName().compareTo(right.file.getName());
            }
        });
        for (Entry entry : entries) {
            if (projected <= limit) {
                break;
            }
            if (deleteQuietly(entry.file)) {
                projected -= entry.length;
            }
        }

    }

    private byte[] readExact(File file, int expectedBytes) throws IOException {
        FileInputStream input = new FileInputStream(file);
        try {
            byte[] result = new byte[expectedBytes];
            int offset = 0;
            while (offset < expectedBytes) {
                int count = input.read(result, offset, expectedBytes - offset);
                if (count < 0) {
                    return null;
                }
                if (count == 0) {
                    continue;
                }
                offset += count;
            }
            if (input.read() != -1) {
                return null;
            }
            return result;
        } finally {
            input.close();
        }
    }

    private void moveIntoPlace(File source, File destination) throws IOException {
        Path sourcePath = source.toPath();
        Path destinationPath = destination.toPath();
        try {
            Files.move(sourcePath, destinationPath,
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(sourcePath, destinationPath, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void touch(File file) {
        try {
            if (isOwnedRegularFile(file)) {
                file.setLastModified(System.currentTimeMillis());
            }
        } catch (SecurityException ignored) {
            // The cached bytes remain usable when metadata cannot be changed.
        }
    }

    private File cacheFile(String sha) {
        if (directory == null || !isValidSha(sha)) {
            return null;
        }
        return new File(directory, sha);
    }

    private boolean ensureDirectory() {
        if (directory == null) {
            return false;
        }
        try {
            if (!directory.isDirectory()) {
                if (!directory.mkdirs() && !directory.isDirectory()) {
                    return false;
                }
            }
            return directory.isDirectory();
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private boolean isCacheDirectory() {
        try {
            return directory != null && directory.isDirectory();
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private File[] listFiles() {
        try {
            return directory.listFiles();
        } catch (SecurityException ignored) {
            return null;
        }
    }

    private boolean isCacheEntry(File file) {
        return file != null && isValidSha(file.getName()) && isOwnedRegularFile(file);
    }

    private boolean isTemporaryEntry(File file) {
        if (file == null || !isOwnedRegularFile(file)) {
            return false;
        }
        String name = file.getName();
        return name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX);
    }

    private boolean isOwnedRegularFile(File file) {
        try {
            if (!file.isFile()) {
                return false;
            }
            return Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS);
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private boolean isUnusedSince(File file, long now, long ageMillis) {
        long lastModified = file.lastModified();
        return lastModified > 0L && now >= lastModified && now - lastModified >= ageMillis;
    }

    private boolean deleteQuietly(File file) {
        try {
            return (!file.exists() || file.delete()) && !file.exists();
        } catch (SecurityException ignored) {
            return false;
        }
    }

    private long limitBytes() {
        return (long) limitMiB * 1024L * 1024L;
    }

    private static int normalizeLimit(int limitMiB) {
        if (limitMiB <= 0) {
            return 0;
        }
        return Math.min(limitMiB, MAX_LIMIT_MIB);
    }

    private static long saturatedAdd(long left, long right) {
        if (right > 0L && left > Long.MAX_VALUE - right) {
            return Long.MAX_VALUE;
        }
        return left + right;
    }

    private static boolean isValidSha(String sha) {
        if (sha == null || sha.length() != 64) {
            return false;
        }
        for (int i = 0; i < sha.length(); i++) {
            char c = sha.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    private static final class Entry {
        final File file;
        final long length;
        final long lastUsed;

        Entry(File file, long length, long lastUsed) {
            this.file = file;
            this.length = length;
            this.lastUsed = lastUsed;
        }
    }
}
