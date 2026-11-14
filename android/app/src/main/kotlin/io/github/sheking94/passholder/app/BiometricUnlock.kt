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
 * vault holds in memory (the 32-byte vault key, see PhoneVaultStore.exportUnlockKeys) is encrypted with
 * an AES-256-GCM key that lives in the Android Keystore. That key never leaves the Keystore (on most phones
 * a separate secure chip) and the Keystore uses it only right after a strong biometric check, once per
 * operation. Adding a new fingerprint to the phone destroys the key, so someone who knows the screen PIN
 * cannot enroll their own finger and unlock the vault.
 *
 * On disk (SharedPreferences "biometric", excluded from backups): the GCM nonce and the encrypted key. Works for
 * keys of any length: keys stored by an older version (64 bytes) are refused by unlockWithKeys, and
 * BiometricController then turns fingerprint unlock off.
 */
class BiometricUnlock(context: Context, private val keys: UnlockKeyProtector = KeystoreKeyProtector()) {
    private val prefs = context.getSharedPreferences("biometric", Context.MODE_PRIVATE)

    val isEnabled: Boolean get() = prefs.contains(DATA)

    /** Step 1 of turning it on: a new Keystore key and a cipher ready to encrypt, once a finger unlocks it. */
    fun cipherToEnable(): Cipher = keys.newEncryptCipher()

    /** Step 2: [cipher] came back from a successful fingerprint check. Encrypts [unlockKeys] and remembers them. */
    fun enable(cipher: Cipher, unlockKeys: ByteArray) {
        val encrypted = cipher.doFinal(unlockKeys)
        prefs.edit {
            putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            putString(DATA, Base64.encodeToString(encrypted, Base64.NO_WRAP))
        }
    }

    /**
     * A cipher ready to decrypt the stored keys after a fingerprint check.
     * Throws [BiometricKeyLostException] when the key is gone (new fingerprint enrolled, screen lock removed);
     * the stored keys are then useless and are deleted.
     */
    fun cipherToUnlock(): Cipher {
        val iv = prefs.getString(IV, null) ?: throw BiometricKeyLostException()
        val cipher = try {
            keys.decryptCipher(Base64.decode(iv, Base64.NO_WRAP))
        } catch (e: KeyPermanentlyInvalidatedException) {
            null
        }
        return cipher ?: run {
            disable()
            throw BiometricKeyLostException()
        }
    }

    /** [cipher] came back from a successful fingerprint check. Returns the keys for PhoneVaultStore.unlockWithKeys. */
    fun decrypt(cipher: Cipher): ByteArray {
        val data = prefs.getString(DATA, null) ?: throw BiometricKeyLostException()
        return cipher.doFinal(Base64.decode(data, Base64.NO_WRAP))
    }

    /** Forgets the encrypted keys and destroys the Keystore key. The master password keeps working. */
    fun disable() {
        prefs.edit { clear() }
        keys.deleteKey()
    }

    private companion object {
        const val IV = "iv"
        const val DATA = "data"
    }
}

class BiometricKeyLostException : Exception(MESSAGE) {
    companion object {
        const val MESSAGE = "Odcisk palca przestał działać (np. dodano nowy odcisk w telefonie). Odblokuj hasłem głównym i włącz go ponownie."
    }
}

/** Makes the ciphers. [KeystoreKeyProtector] on the phone; tests use a plain software key (Robolectric has no Keystore). */
interface UnlockKeyProtector {
    fun newEncryptCipher(): Cipher
    /** Null when there is no key. */
    fun decryptCipher(iv: ByteArray): Cipher?
    fun deleteKey()
}

class KeystoreKeyProtector : UnlockKeyProtector {
    private fun keyStore() = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    override fun newEncryptCipher(): Cipher {
        // Generating under the same alias replaces the old key. StrongBox (a separate secure chip) where the phone
        // has one; otherwise the usual hardware-backed Keystore (security review I2).
        val key = runCatching { generateKey(strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) }
            .recover { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && it is StrongBoxUnavailableException) generateKey(strongBox = false) else throw it }
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

enum class BiometricAvailability { Ready, NoFingerprint, Unsupported }

/** Shows the system fingerprint dialog. [SystemFingerprintPrompt] on the phone, a fake in tests. */
interface FingerprintPrompt {
    fun availability(context: Context): BiometricAvailability

    /** [onError] gets null when the user just cancelled or chose the master password. */
    fun authenticate(activity: FragmentActivity, title: String, cipher: Cipher, onSuccess: (Cipher) -> Unit, onError: (String?) -> Unit)
}

object SystemFingerprintPrompt : FingerprintPrompt {
    override fun availability(context: Context) = when (BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG)) {
        BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.Ready
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NoFingerprint
        else -> BiometricAvailability.Unsupported
    }

    override fun authenticate(activity: FragmentActivity, title: String, cipher: Cipher, onSuccess: (Cipher) -> Unit, onError: (String?) -> Unit) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                result.cryptoObject?.cipher?.let(onSuccess) ?: onError("Brak klucza po weryfikacji odcisku")
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                onError(if (cancelled) null else errString.toString())
            }
            // onAuthenticationFailed (a finger that does not match): the dialog stays open and says so itself.
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setNegativeButtonText("Użyj hasła głównego")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
}
