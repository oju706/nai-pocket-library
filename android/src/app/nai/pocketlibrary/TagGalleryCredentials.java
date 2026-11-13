package app.nai.pocketlibrary;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class TagGalleryCredentials {
    private static final String STORE = "AndroidKeyStore";
    private static final String ALIAS = "nai-pocket-tag-gallery";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;
    private final SharedPreferences preferences;

    TagGalleryCredentials(Context context) {
        preferences = context.getSharedPreferences("tag-gallery-connections", Context.MODE_PRIVATE);
    }

    static final class Account {
        final String name;
        final String key;

        Account(String name, String key) {
            this.name = name;
            this.key = key;
        }
    }

    synchronized void save(String site, String account, String key) throws IOException {
        requireSite(site);
        if (account.isEmpty() && key.isEmpty()) {
            if (!preferences.edit().remove(site).commit()) throw new IOException("暂时无法清除连接。");
            return;
        }
        String accountPattern = "gelbooru".equals(site) ? "[0-9]{1,20}" : "[A-Za-z0-9_.-]{1,100}";
        if (!account.matches(accountPattern) || !key.matches("[\\x21-\\x7e]{8,256}")) {
            throw new IOException("请填写正确的用户 ID 或登录名，以及 API Key。");
        }
        try {
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.ENCRYPT_MODE, secret(true));
            cipher.updateAAD(site.getBytes(StandardCharsets.UTF_8));
            byte[] payload = cipher.doFinal(new JSONObject().put("account", account).put("key", key)
                    .toString().getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            if (iv.length != IV_BYTES) throw new GeneralSecurityException("Invalid IV length");
            byte[] stored = Arrays.copyOf(iv, iv.length + payload.length);
            System.arraycopy(payload, 0, stored, iv.length, payload.length);
            if (!preferences.edit().putString(site, Base64.encodeToString(stored, Base64.NO_WRAP)).commit()) {
                throw new IOException("暂时无法保存连接。");
            }
        } catch (GeneralSecurityException | JSONException failure) {
            throw new IOException("安卓安全存储暂不可用，请稍后重试。");
        }
    }

    synchronized Account load(String site) throws IOException {
        requireSite(site);
        String encoded = preferences.getString(site, null);
        if (encoded == null) return null;
        try {
            byte[] stored = Base64.decode(encoded, Base64.NO_WRAP);
            if (stored.length <= IV_BYTES) throw new GeneralSecurityException("Invalid stored credentials");
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, secret(false), new GCMParameterSpec(128, stored, 0, IV_BYTES));
            cipher.updateAAD(site.getBytes(StandardCharsets.UTF_8));
            JSONObject data = new JSONObject(new String(cipher.doFinal(stored, IV_BYTES, stored.length - IV_BYTES),
                    StandardCharsets.UTF_8));
            return new Account(data.getString("account"), data.getString("key"));
        } catch (GeneralSecurityException | JSONException | IllegalArgumentException failure) {
            throw new IOException("已保存的连接无法读取，请重新填写 API 凭据。");
        }
    }

    private static void requireSite(String site) throws IOException {
        if (!"danbooru".equals(site) && !"gelbooru".equals(site)) throw new IOException("未知图站。");
    }

    private static SecretKey secret(boolean create) throws IOException, GeneralSecurityException {
        KeyStore store = KeyStore.getInstance(STORE);
        store.load(null);
        Key key = store.getKey(ALIAS, null);
        if (key instanceof SecretKey) return (SecretKey) key;
        if (!create) throw new GeneralSecurityException("Missing encryption key");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }
}
