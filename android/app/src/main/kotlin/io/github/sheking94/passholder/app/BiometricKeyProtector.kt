package io.github.sheking94.passholder.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Makes the ciphers. [KeystoreKeyProtector] on the phone; tests use a plain software key (Robolectric has no Keystore). */
interface BiometricKeyProtector {
    fun newEncryptCipher(): Cipher

    /** Null when there is no key. */
    fun decryptCipher(iv: ByteArray): Cipher?
    fun deleteKey()
}

class KeystoreKeyProtector : BiometricKeyProtector {
    private fun keyStore() = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    override fun newEncryptCipher(): Cipher {
        // Generating under the same alias replaces the old key. StrongBox (a separate secure chip) where the phone
        // has one; otherwise the usual hardware-backed Keystore (security review I2).
        val key = runCatching { generateKey(strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) }
            .recover {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                    it is StrongBoxUnavailableException
                ) {
                    generateKey(strongBox = false)
                } else {
                    throw it
                }
            }
            .getOrThrow()
        // The Keystore picks the nonce itself; it is read back from cipher.iv after encrypting.
        return Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
    }

    private fun generateKey(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // Every use needs a fresh strong biometric check (no "valid for N seconds" window).
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    // The key works only while the phone's own screen lock is open.
                    setUnlockedDeviceRequired(true)
                    if (strongBox) setIsStrongBoxBacked(true)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                }
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec) }.generateKey()
    }

    override fun decryptCipher(iv: ByteArray): Cipher? {
        val key = keyStore().getKey(ALIAS, null) as SecretKey? ?: return null
        return Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }
    }

    override fun deleteKey() {
        keyStore().run { if (containsAlias(ALIAS)) deleteEntry(ALIAS) }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "passholder-biometric-unlock"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
