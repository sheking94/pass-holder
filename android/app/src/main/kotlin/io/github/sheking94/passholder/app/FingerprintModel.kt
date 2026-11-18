package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.app.ui.FingerprintActions
import io.github.sheking94.passholder.app.ui.StatusActions
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlinx.coroutines.flow.StateFlow
import javax.crypto.Cipher

/** Fingerprint unlock for the screens: turning it on and off, and unlocking with it ([BiometricController] does the keys). */
internal class FingerprintModel(
    private val ui: UiStateHolder,
    private val store: PhoneVaultStore,
    private val biometrics: BiometricController,
    private val locks: LockController,
    /** Read on every use: tests replace it. */
    private val fingerprintPrompt: () -> FingerprintPrompt,
    private val readerAvailability: () -> BiometricAvailability,
) : FingerprintActions,
    StatusActions by ui {
    override val enabled: StateFlow<Boolean> = biometrics.enabled

    override val timesLeftApp: StateFlow<Int> = locks.timesLeftApp

    override val prompt: FingerprintPrompt get() = fingerprintPrompt()

    override fun availability(): BiometricAvailability = readerAvailability()

    override fun takeOfferOnLockedScreen(): Boolean = locks.takeFingerprintOffer(biometrics.enabled.value) && !store.isUnlocked

    override fun cipherToEnable(): Cipher? = if (ui.busy) null else preparing(biometrics::cipherToEnable)

    override fun onEnableAuthorized(cipher: Cipher) = ui.launchOperation("Włączam odcisk palca…") {
        store.exportVaultKey().useAndWipe { vaultKey -> biometrics.enable(cipher, vaultKey) }
        ui.showStatus("Włączono odblokowanie odciskiem palca. Hasło główne nadal działa.")
    }

    override fun disable() {
        biometrics.disable()
        ui.showStatus("Wyłączono odblokowanie odciskiem palca.")
    }

    /** Any problem leaves the master password field as the way in. */
    override fun cipherToUnlock(): Cipher? = if (ui.busy || !biometrics.enabled.value) null else preparing(biometrics::cipherToUnlock)

    override fun onUnlockAuthorized(cipher: Cipher) = ui.launchOperation("Odblokowuję…") {
        biometrics.unlock(cipher, store::unlockWithVaultKey)
        ui.showList(null)
    }

    /** The cipher from [prepare], or null with its error on the status line. */
    private fun preparing(prepare: () -> Cipher): Cipher? = try {
        prepare()
    } catch (e: Exception) {
        fail(errorMessage(e))
        null
    }
}
