package io.github.sheking94.passholder.app.ui

import android.net.Uri
import io.github.sheking94.passholder.app.BiometricAvailability
import io.github.sheking94.passholder.app.FingerprintPrompt
import io.github.sheking94.passholder.app.InstalledApp
import io.github.sheking94.passholder.app.SyncUiState
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.PairingOffer
import io.github.sheking94.passholder.core.transfer.TransferFormat
import kotlinx.coroutines.flow.StateFlow
import javax.crypto.Cipher

/*
 * What the screens may call. Each screen gets only the groups it uses (state comes as UiState), not the whole
 * AppViewModel, so a screen can be shown with a fake of these. The ViewModel's parts implement them.
 */

/** The status line under every screen. */
interface StatusActions {
    /** Shows [message] as an error. */
    fun fail(message: String)

    /** Drops the status line when it shows an error, so a fixed field does not keep its stale message. */
    fun clearError()
}

/** Moving between the vault's screens. */
interface Navigation {
    /** Back to the list, on the tab of the entry that was being edited (or the tab it was on). Ignored while busy. */
    fun backToList()

    fun openSettings()

    /** "Zmień hasło główne", from Ustawienia. */
    fun openChangePassword()

    /** ⋮ → "Import i eksport". */
    fun openTransfer()

    /** "Synchronizacja": sync mode starts with the screen. */
    fun openSync()

    /** "Urządzenia": the paired extensions. */
    fun openDevices()

    fun selectTab(type: EntryType)

    /** "+ Dodaj": an empty form for an entry of [type]. */
    fun newEntry(type: EntryType)

    /** The edit form for [id], read from the store first (the list may predate a sync). */
    fun openEntry(id: String)
}

/** Creating, restoring, unlocking, locking and removing the vault, and its master password. */
interface VaultActions {
    /** "Nowy sejf": the master password must pass MasterPasswordRules. */
    fun createVault(masterPassword: String, repeat: String)

    /** "Odtwórz z wtyczki": a new identity without a vault, waiting for the extension to send it. */
    fun startRestore()

    /** "Zakończ odtwarzanie": the extension sent the vault; its master password opens it on the phone. */
    fun finishRestore(masterPassword: String)

    /** "Przerwij odtwarzanie": forget the restore (and the extensions paired for it) and go back to the start. */
    fun abortRestore()

    fun unlock(masterPassword: String)

    fun lock()

    /** "Usuń sejf z telefonu" (after the confirmation on screen): the entries stay only on the paired extensions. */
    fun disconnect()

    /** "Zmień hasło": paired extensions are forgotten and fingerprint unlock is turned off. */
    fun changeMasterPassword(oldPassword: String, newPassword: String, repeat: String)
}

/**
 * Fingerprint unlock. The screen shows the system dialog (FingerprintDialog, it needs the activity); these prepare
 * the cipher it unlocks and take it back.
 */
interface FingerprintActions : StatusActions {
    /** Fingerprint unlock is turned on. */
    val enabled: StateFlow<Boolean>

    /** Goes up each time the app leaves the screen; the locked screen then offers the dialog again. */
    val timesLeftApp: StateFlow<Int>

    /** The system dialog (replaced in tests: Robolectric has no fingerprint reader). */
    val prompt: FingerprintPrompt

    fun availability(): BiometricAvailability

    /** Called once by the locked screen when it appears: true means "open the dialog now". */
    fun takeOfferOnLockedScreen(): Boolean

    /** Turning it on, step 1: the cipher to unlock, or null (the reason is on the status line, or busy). */
    fun cipherToEnable(): Cipher?

    /** Step 2: the finger confirmed it is the owner. */
    fun onEnableAuthorized(cipher: Cipher)

    fun disable()

    /** Unlocking, step 1: null while busy, when it is off, or with the reason on the status line. */
    fun cipherToUnlock(): Cipher?

    /** Step 2: [cipher] came back from the dialog. */
    fun onUnlockAuthorized(cipher: Cipher)
}

/** Sync mode and the paired devices. */
interface SyncActions {
    /** Server, addresses, pairing code, last event, paired devices. */
    val state: StateFlow<SyncUiState>

    /** Sync mode again after it turned itself off or failed to start ("Włącz ponownie"); a new code while restoring. */
    fun startSync()

    /** "Zakończ": the server stops, back to the list. */
    fun closeSync()

    /** "Dodaj wtyczkę" (and "Nowy kod" while restoring): a new 8-digit pairing code for 2 minutes. */
    fun addExtension()

    /** For the countdown on screen: milliseconds left on [offer]; drops the code once it can no longer be used. */
    fun pairingCodeRemainingMs(offer: PairingOffer): Long

    /** "Usuń" on Urządzenia (after the confirmation): the extension can no longer sync. */
    fun removeDevice(id: String)
}

/** The switches of "Ustawienia" that are plain settings. */
interface SettingsActions {
    /** "Blokuj dopiero po 60 s poza aplikacją". */
    val lockDelay: StateFlow<Boolean>

    fun setLockDelay(on: Boolean)

    /** "Pytaj o zapis haseł". */
    val askToSave: StateFlow<Boolean>

    fun setAskToSave(on: Boolean)

    /** Whether PassHolder is the system's autofill service (read again each time the screen resumes). */
    fun autofillEnabled(): Boolean
}

/** The entry form: save, delete, copy a field, the password generator and the apps of a login. */
interface EntryActions : StatusActions {
    /** "Zapisz". [original] is the content the form was opened with (null for a new entry). */
    fun save(id: String?, content: EntryContent, original: EntryContent?)

    fun delete(id: String)

    /** Copies a plain field (login, a visible custom field). [label] is a copy noun ("login"). */
    fun copyText(label: String, value: String)

    /** Copies a secret (password, TOTP, card number…): marked sensitive and cleared from the clipboard after a while. */
    fun copySecret(label: String, value: String)

    /** The generator's last used options. */
    fun generatorOptions(): GeneratorOptions

    /** A new password; the [options] are remembered. Null with the reason on the status line when they allow none. */
    fun generatePassword(options: GeneratorOptions): String?

    /** The installed launcher apps a login can be tied to. Blocking: call it off the main thread. */
    fun installedApps(): List<InstalledApp>

    /** An installed app picked for a login: its certificate is remembered (security review V3-S3). */
    fun trustPickedApp(packageName: String)
}

/** The system file picker: a trip out of the app that gets 60 s before the lock (see LockController). */
interface FilePicks : StatusActions {
    /** Just before the picker is launched. */
    fun beginFilePick()

    /** The picker returned or could not be launched. */
    fun endFilePick()
}

/** "Załączniki" of the entry form. */
interface AttachmentActions : FilePicks {
    /** The file chosen for "+ Dodaj plik" (null: cancelled); [onAdded] gets it once encrypted. [count]: files already in the form. */
    fun attachFile(uri: Uri?, count: Int, onAdded: (Attachment) -> Unit)

    /** The ids of the [attachments] complete on the phone. */
    suspend fun fileReady(attachments: List<Attachment>): Set<String>

    /** The document created for "Pobierz" (null: cancelled): the decrypted file is written there. */
    fun downloadFile(attachment: Attachment, uri: Uri?)
}

/** "Import i eksport". */
interface TransferActions : FilePicks {
    /** The file chosen for "Importuj plik" (null: cancelled). */
    fun importFrom(uri: Uri?)

    /** The master password again before a plain-text export; only then does [onConfirmed] open the save dialog. */
    fun confirmExport(masterPassword: String, onConfirmed: () -> Unit)

    /** The document created for "Zapisz plik" (null: cancelled). */
    fun exportTo(format: TransferFormat, uri: Uri?)

    /** The same for PassHolder ZIP: the entries with their decrypted files. */
    fun exportArchiveTo(uri: Uri?)
}
