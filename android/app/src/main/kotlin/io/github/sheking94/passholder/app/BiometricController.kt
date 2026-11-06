package io.github.sheking94.passholder.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.crypto.Cipher

/**
 * Fingerprint unlock as the ViewModel sees it: whether it is on, the ciphers for the system dialog, and what
 * to do with the cipher the dialog gives back. No Android UI here: the screen shows the dialog itself
 * (ui/FingerprintDialog.kt), because the dialog needs the activity and the ViewModel must not hold one.
 */
class BiometricController(private val biometric: BiometricUnlock) {
    private val _enabled = MutableStateFlow(biometric.isEnabled)
    /** Fingerprint unlock is turned on (the encrypted keys are on the phone). */
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    /** Step 1 of turning it on: a new Keystore key. Throws with a message for the user. */
    fun cipherToEnable(): Cipher = try {
        biometric.cipherToEnable()
    } catch (e: Exception) {
        throw IllegalStateException("Nie udało się przygotować klucza: ${e.message ?: e.javaClass.simpleName}", e)
    }

    /** Step 2: [cipher] came back from the dialog; [unlockKeys] is the 32-byte vault key. Blocking (Keystore): run it as a vault operation. */
    fun enable(cipher: Cipher, unlockKeys: ByteArray) {
        biometric.enable(cipher, unlockKeys)
        _enabled.value = true
    }

    /** The cipher that decrypts the stored keys after a fingerprint check. Throws with a message for the user. */
    fun cipherToUnlock(): Cipher = try {
        biometric.cipherToUnlock()
    } catch (e: BiometricKeyLostException) {
        _enabled.value = false
        throw e
    } catch (e: Exception) {
        throw IllegalStateException("Odcisk palca niedostępny: ${e.message ?: e.javaClass.simpleName}", e)
    }

    /**
     * [cipher] came back from the dialog: decrypts the stored keys, passes them to [unlock] and zeroes them.
     * Keys of some other vault will never work again, so fingerprint unlock is turned off then.
     */
    fun unlock(cipher: Cipher, unlock: (keys: ByteArray) -> Unit) {
        biometric.decrypt(cipher).useAndWipe { keys ->
            try {
                unlock(keys)
            } catch (e: IllegalArgumentException) {
                disable()
                throw IllegalArgumentException("Zapisane klucze nie pasują do sejfu. Odblokuj hasłem głównym i włącz odcisk ponownie.", e)
            }
        }
    }

    fun disable() {
        biometric.disable()
        _enabled.value = false
    }
}

/** Runs [block] with this array and zeroes it afterwards, also when [block] throws. For keys. */
inline fun <T> ByteArray.useAndWipe(block: (ByteArray) -> T): T = try {
    block(this)
} finally {
    fill(0)
}
