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

/**
 * Fingerprint unlock.
 *
 * The master password is never stored. When the user turns this on (vault unlocked), the key the unlocked
 * vault holds in memory (the 32-byte vault key, see PhoneVaultStore.exportVaultKey) is encrypted with
 * an AES-256-GCM key that lives in the Android Keystore. That key never leaves the Keystore (on most phones
 * a separate secure chip) and the Keystore uses it only right after a strong biometric check, once per
 * operation. Adding a new fingerprint to the phone destroys the key, so someone who knows the screen PIN
 * cannot enroll their own finger and unlock the vault.
 *
 * On disk (SharedPreferences "biometric", excluded from backups): the GCM nonce and the encrypted key. Works for
 * keys of any length: keys stored by an older version (64 bytes) are refused by unlockWithVaultKey, and
 * BiometricController then turns fingerprint unlock off.
 */
class BiometricUnlock(context: Context, private val protector: BiometricKeyProtector = KeystoreKeyProtector()) {
    private val prefs = context.getSharedPreferences("biometric", Context.MODE_PRIVATE)

    val isEnabled: Boolean get() = prefs.contains(DATA)

    /** Step 1 of turning it on: a new Keystore key and a cipher ready to encrypt, once a finger unlocks it. */
    fun cipherToEnable(): Cipher = protector.newEncryptCipher()

    /** Step 2: [cipher] came back from a successful fingerprint check. Encrypts [vaultKey] and remembers it. */
    fun enable(cipher: Cipher, vaultKey: ByteArray) {
        val encrypted = cipher.doFinal(vaultKey)
        prefs.edit {
            putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            putString(DATA, Base64.encodeToString(encrypted, Base64.NO_WRAP))
        }
    }

    /**
     * A cipher ready to decrypt the stored vault key after a fingerprint check.
     * Throws [BiometricKeyLostException] when the key is gone (new fingerprint enrolled, screen lock removed);
     * the stored vault key is then useless and is deleted.
     */
    fun cipherToUnlock(): Cipher {
        val iv = prefs.getString(IV, null) ?: throw BiometricKeyLostException()
        val cipher = try {
            protector.decryptCipher(Base64.decode(iv, Base64.NO_WRAP))
        } catch (e: KeyPermanentlyInvalidatedException) {
            null
        }
        return cipher ?: run {
            disable()
            throw BiometricKeyLostException()
        }
    }

    /** [cipher] came back from a successful fingerprint check. Returns the vault key for PhoneVaultStore.unlockWithVaultKey. */
    fun decrypt(cipher: Cipher): ByteArray {
        val data = prefs.getString(DATA, null) ?: throw BiometricKeyLostException()
        return cipher.doFinal(Base64.decode(data, Base64.NO_WRAP))
    }

    /** Forgets the encrypted vault key and destroys the Keystore key. The master password keeps working. */
    fun disable() {
        prefs.edit { clear() }
        protector.deleteKey()
    }

    private companion object {
        const val IV = "iv"
        const val DATA = "data"
    }
}

class BiometricKeyLostException : Exception(MESSAGE) {
    companion object {
        const val MESSAGE =
            "Odcisk palca przestał działać (np. dodano nowy odcisk w telefonie). " +
                "Odblokuj hasłem głównym i włącz go ponownie."
    }
}
