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

enum class BiometricAvailability { Ready, NoFingerprint, Unsupported }

/** How the fingerprint dialog ended. */
sealed interface FingerprintResult {
    /** A matching finger: [cipher] may now be used once. */
    class Authorized(val cipher: Cipher) : FingerprintResult

    /** The system's reason (too many attempts, the sensor failed…), for the status line. */
    class Failed(val message: String) : FingerprintResult

    /** The user cancelled or chose the master password: not an error. */
    data object Cancelled : FingerprintResult
}

/** Shows the system fingerprint dialog. [SystemFingerprintPrompt] on the phone, a fake in tests. */
interface FingerprintPrompt {
    fun availability(context: Context): BiometricAvailability

    /** Shows the dialog titled [title] that unlocks [cipher]; [onResult] gets how it ended. */
    fun authenticate(activity: FragmentActivity, title: String, cipher: Cipher, onResult: (FingerprintResult) -> Unit)
}

object SystemFingerprintPrompt : FingerprintPrompt {
    override fun availability(context: Context) = when (BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG)) {
        BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.Ready
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NoFingerprint
        else -> BiometricAvailability.Unsupported
    }

    override fun authenticate(activity: FragmentActivity, title: String, cipher: Cipher, onResult: (FingerprintResult) -> Unit) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val unlocked = result.cryptoObject?.cipher
                onResult(
                    if (unlocked !=
                        null
                    ) {
                        FingerprintResult.Authorized(unlocked)
                    } else {
                        FingerprintResult.Failed("Brak klucza po weryfikacji odcisku")
                    },
                )
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                onResult(if (cancelled) FingerprintResult.Cancelled else FingerprintResult.Failed(errString.toString()))
            }
            // onAuthenticationFailed (a finger that does not match): the dialog stays open and says so itself.
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setNegativeButtonText("Użyj hasła głównego")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            callback,
        ).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
}
