package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.app.ui.VaultActions
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore

/** The vault's life on the phone: create, restore from the extension, unlock, lock, remove, change the master password. */
internal class VaultModel(
    private val ui: UiStateHolder,
    private val store: PhoneVaultStore,
    private val sync: SyncModel,
    private val locks: LockController,
    private val biometrics: BiometricController,
) : VaultActions {
    override fun createVault(masterPassword: String, repeat: String) {
        MasterPasswordRules.problem(masterPassword)?.let { return ui.fail(it) }
        if (masterPassword != repeat) return ui.fail(UiTexts.PASSWORDS_DIFFER)
        ui.launchOperation("Liczę klucze z hasła głównego… (to celowo trwa kilka sekund)") {
            store.createVault(masterPassword)
            // A fingerprint key left from an earlier vault would only fail.
            forgetFingerprint()
            ui.showList("Założono sejf na telefonie.")
        }
    }

    override fun startRestore() = ui.launchOperation("Przygotowuję odtwarzanie…") {
        store.startRestore()
        forgetFingerprint()
        ui.replace(UiState(Screen.Restore))
        sync.startRestoreSync()
    }

    override fun finishRestore(masterPassword: String) {
        if (masterPassword.isEmpty()) return ui.fail("Podaj hasło główne")
        ui.launchOperation("Liczę klucze z hasła głównego…") {
            store.finishRestore(masterPassword)
            sync.stop()
            ui.showList("Odtworzono sejf z wtyczki. Od teraz przechowuje go ten telefon.")
        }
    }

    override fun abortRestore() = disconnect()

    override fun unlock(masterPassword: String) = ui.launchOperation("Odblokowuję…") {
        store.unlock(masterPassword)
        ui.showList(null)
    }

    override fun lock() = ui.launchOperation("Blokuję…") {
        sync.stop()
        store.lock()
        locks.onLockedByUser()
        ui.replace(UiState(Screen.Locked))
    }

    override fun disconnect() = ui.launchOperation("Usuwam sejf z telefonu…") {
        sync.stop()
        store.disconnect()
        // The vault is gone: whatever happens to the fingerprint key below, the start screen is the only right one.
        val warning = forgetFingerprint().exceptionOrNull()?.let {
            Status("Usunięto sejf, ale nie udało się usunąć klucza odcisku palca: ${errorMessage(it)}", isError = true)
        }
        ui.replace(UiState(Screen.Start, status = warning))
    }

    /** The same vault key wrapped with [newPassword] (security review I1): each extension pairs again with it. */
    override fun changeMasterPassword(oldPassword: String, newPassword: String, repeat: String) {
        if (oldPassword.isEmpty()) return ui.fail("Podaj obecne hasło główne")
        MasterPasswordRules.problem(newPassword)?.let { return ui.fail(it) }
        if (newPassword != repeat) return ui.fail(UiTexts.PASSWORDS_DIFFER)
        if (newPassword == oldPassword) return ui.fail(errorMessage(ErrorCode.PASSWORD_UNCHANGED))
        ui.launchOperation("Liczę klucze z nowego hasła… (to celowo trwa kilka sekund)") {
            sync.stop()
            store.changeMasterPassword(oldPassword, newPassword)
            val hadFingerprint = biometrics.enabled.value
            val fingerprintError = forgetFingerprint().exceptionOrNull()
            sync.refreshDevices()
            val text = buildString {
                append("Zmieniono hasło główne. Sparuj ponownie każdą wtyczkę i wpisz w niej nowe hasło.")
                if (hadFingerprint) append(" Odblokowanie odciskiem palca wyłączono, możesz je włączyć ponownie.")
                fingerprintError?.let { append(" Nie udało się usunąć klucza odcisku palca: ${errorMessage(it)}") }
            }
            ui.update { it.copy(screen = Screen.Settings, status = Status(text, isError = fingerprintError != null)) }
        }
    }

    /**
     * Turns fingerprint unlock off: the stored key belongs to the vault that is gone or replaced, and a vault
     * created later needs its own. Returns a failure instead of throwing; the encrypted key is forgotten even then
     * (BiometricUnlock clears it before it deletes the Keystore key).
     */
    private fun forgetFingerprint(): Result<Unit> = runCatching { biometrics.disable() }
}
