package io.github.sheking94.passholder.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.github.sheking94.passholder.core.p2p.SecretWrapper
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Wraps the phone's secrets on disk (the private key of its sync identity in host.json) with an AES-256-GCM
 * key that lives in the Android Keystore and never leaves it.
 *
 * Unlike the fingerprint key, this one needs no user authentication: the phone must answer the extension's
 * sync requests while the vault is locked, without a finger on the reader. Format: `iv.base64 + ":" + ct.base64`.
 *
 * Nothing touches the Keystore before the first [wrap] or [unwrap]; the key is created on first use.
 */
class KeystoreSecretWrapper(private val alias: String = "passholder-p2p-wrap") : SecretWrapper {
    override fun wrap(secret: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, existingKey() ?: newKey()) }
        // The Keystore picks the nonce itself; it is read back from cipher.iv.
        val ct = cipher.doFinal(secret)
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    }

    override fun unwrap(wrapped: String): ByteArray {
        val parts = wrapped.split(":")
        require(parts.size == 2) { "Wrapped secret must be iv:ciphertext" }
        val (iv, ct) = parts.map { Base64.decode(it, Base64.NO_WRAP) }
        // A missing key cannot be replaced: what it wrapped is lost (e.g. the app's data was moved to another phone).
        val key = existingKey() ?: throw IllegalStateException("Brak klucza telefonu w Android Keystore")
        return Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }.doFinal(ct)
    }

    private fun existingKey(): SecretKey? =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.getKey(alias, null) as SecretKey?

    @Synchronized
    private fun newKey(): SecretKey = existingKey() ?: run {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .build()
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec) }.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
