package io.github.sheking94.passholder.app

import android.app.Application
import android.net.Uri
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.tidyContent
import io.github.sheking94.passholder.app.entries.validateContent
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.Attachments
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.EntryTooLargeException
import io.github.sheking94.passholder.core.p2p.EntryTypeMismatchException
import io.github.sheking94.passholder.core.p2p.PairingOffer
import io.github.sheking94.passholder.core.p2p.PhoneEntry
import io.github.sheking94.passholder.core.transfer.PassHolderZip
import io.github.sheking94.passholder.core.transfer.Transfer
import io.github.sheking94.passholder.core.transfer.TransferFormat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import javax.crypto.Cipher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID

sealed interface Screen {
    /** The screens that show what is in the vault: they must not stay on screen once it locks. */
    val showsVault: Boolean get() = false

    /** No vault on the phone: create one, or restore it from the extension. */
    data object Start : Screen
    data object Locked : Screen
    data object List : Screen {
        override val showsVault get() = true
    }
    /** [id] is null for a new entry of [type]. */
    data class Edit(val id: String?, val type: EntryType) : Screen {
        override val showsVault get() = true
    }
    /** "Ustawienia": fingerprint unlock and the lock delay. */
    data object Settings : Screen {
        override val showsVault get() = true
    }
    /** "Zmień hasło główne", opened from Ustawienia. */
    data object ChangePassword : Screen {
        override val showsVault get() = true
    }
    /** "Import i eksport": files of PassHolder, Bitwarden and NordPass. */
    data object Transfer : Screen {
        override val showsVault get() = true
    }
    /** Sync mode: the phone serves the extension. */
    data object Sync : Screen {
        override val showsVault get() = true
    }
    /** Paired extensions. */
    data object Devices : Screen {
        override val showsVault get() = true
    }
    /** "Odtwórz z wtyczki" in progress: the server runs and waits for the extension to send the vault. */
    data object Restore : Screen
}

data class Status(val text: String, val isError: Boolean = false)

data class UiState(
    val screen: Screen,
    val busy: Boolean = false,
    val status: Status? = null,
    val entries: List<PhoneEntry> = emptyList(),
    /** Records the vault key cannot open (e.g. sent by an extension of another vault). */
    val unreadable: Int = 0,
    /** The entry on [Screen.Edit], read from the store when it was opened (not from [entries], which may be older). */
    val editing: PhoneEntry? = null,
    /** host.json cannot be read: the start screen offers only to remove the vault from the phone. */
    val corruptVault: Boolean = false,
    /** The list's tab: the type of entries it shows. */
    val tab: EntryType = EntryType.LOGIN,
)

/**
 * The single source of UI state. Every operation on the vault runs on Dispatchers.IO (Argon2id, disk),
 * one at a time; the screens only read [state] and call these functions.
 * When the vault locks is decided by [LockController], fingerprint unlock by [BiometricController].
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as PassHolderApp
    private val store = app.phoneStore
    private val biometrics = BiometricController(app.biometric)

    private val _state = MutableStateFlow(UiState(initialScreen(), corruptVault = store.corruptState))
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** A sync may have changed entries: the list must not keep (and the edit form must not save over) older ones. */
    private val sync = SyncController(store, app.syncPort, { app.clock() }, app.syncAddresses, onSynced = {
        viewModelScope.launch { refresh() }
    })
    /** Sync mode: server, addresses, pairing code, last event, paired devices. */
    val syncState: StateFlow<SyncUiState> = sync.state

    private val locks = LockController(
        store = store,
        leaveLock = { app.leaveLock },
        lockDelay = { app.settings.lockDelay },
        isBusy = { _state.value.busy },
        currentScreen = { _state.value.screen },
        showLocked = { status ->
            sync.stop(null)
            _state.value = UiState(Screen.Locked, status = status)
        },
    )

    /** Fingerprint unlock is turned on (the encrypted keys are on the phone). */
    val biometricEnabled: StateFlow<Boolean> = biometrics.enabled

    /** Goes up each time the app leaves the screen; the locked screen then offers the fingerprint dialog again. */
    val timesLeftApp: StateFlow<Int> = locks.timesLeftApp

    private val _lockDelay = MutableStateFlow(app.settings.lockDelay)
    /** "Blokuj dopiero po 60 s poza aplikacją" is on. */
    val lockDelay: StateFlow<Boolean> = _lockDelay.asStateFlow()

    private val _askToSave = MutableStateFlow(app.settings.askToSave)
    /** "Pytaj o zapis haseł" is on. */
    val askToSave: StateFlow<Boolean> = _askToSave.asStateFlow()

    init {
        // Auto-lock also while the app sits in the background, as long as the process lives.
        viewModelScope.launch {
            while (true) {
                delay(15_000)
                checkAutoLock()
            }
        }
        // The activity came back while the vault stayed unlocked (e.g. within the 60 s after Back).
        if (store.isUnlocked) viewModelScope.launch { refresh() }
    }

    private fun initialScreen(): Screen = when {
        store.restoreInProgress -> Screen.Restore
        !store.hasVault -> Screen.Start
        store.isUnlocked -> Screen.List
        else -> Screen.Locked
    }

    fun touch() = store.touch()

    // --- Lock lifecycle (see LockController) ----------------------------------------------------

    /** MainActivity.onStop, unless it is only a rotation. Sync mode never runs without the app on screen. */
    fun onLeftApp() {
        sync.stop(SyncController.LEFT_APP_STOPPED)
        locks.onLeftApp()
    }

    /** MainActivity.onStart. A restore in progress gets its server (and a code) back at once. */
    fun onReturn() {
        locks.onReturn()
        if (_state.value.screen == Screen.Restore) startRestoreSync()
        // Unlocked outside this screen (the autofill unlock screen) while the app showed the locked screen.
        if (_state.value.screen == Screen.Locked && !_state.value.busy && store.isUnlocked) showListUnlockedElsewhere()
        // The autofill service may have saved a login in the background; an edit form already open is not reloaded.
        else if (store.isUnlocked) viewModelScope.launch { refresh() }
    }

    /** Every 15 s and on return: the 5-minute idle stop of sync mode, then the 15-minute auto-lock. */
    fun checkAutoLock() {
        if (sync.checkIdle()) viewModelScope.launch { refresh() }
        viewModelScope.launch { locks.checkIdle() }
    }

    fun setLockDelay(on: Boolean) {
        app.settings.lockDelay = on
        _lockDelay.value = on
    }

    fun setAskToSave(on: Boolean) {
        app.settings.askToSave = on
        _askToSave.value = on
    }

    override fun onCleared() {
        sync.stop(null)
        locks.onCleared()
    }

    // --- Start ---------------------------------------------------------------------------------------

    /** "Nowy sejf": the master password must pass [MasterPasswordRules]. */
    fun createVault(masterPassword: String, repeat: String) {
        MasterPasswordRules.problem(masterPassword)?.let { return fail(it) }
        if (masterPassword != repeat) return fail("Hasła się różnią")
        launchVaultOperation("Liczę klucze z hasła głównego… (to celowo trwa kilka sekund)") {
            store.createVault(masterPassword)
            // A fingerprint key left from an earlier vault would only fail.
            forgetFingerprint()
            showList("Założono sejf na telefonie.")
        }
    }

    /** "Odtwórz z wtyczki": a new identity without a vault, waiting for the extension to send it. */
    fun startRestore() = launchVaultOperation("Przygotowuję odtwarzanie…") {
        store.startRestore()
        forgetFingerprint()
        _state.value = UiState(Screen.Restore)
        startRestoreSync()
    }

    /** "Zakończ odtwarzanie": the extension sent the vault; its master password opens it on the phone. */
    fun finishRestore(masterPassword: String) {
        if (masterPassword.isEmpty()) return fail("Podaj hasło główne")
        launchVaultOperation("Liczę klucze z hasła głównego…") {
            store.finishRestore(masterPassword)
            sync.stop(null)
            showList("Odtworzono sejf z wtyczki. Od teraz przechowuje go ten telefon.")
        }
    }

    /** "Przerwij odtwarzanie": forget the restore (and the extensions paired for it) and go back to the start. */
    fun abortRestore() = disconnect()

    /**
     * Restore mode: the server runs from the start and, until an extension paired, a fresh server comes with a
     * fresh code. A server that was already running (e.g. after a rotation) keeps its code, or its
     * "Kod wygasł…" hint.
     */
    private fun startRestoreSync() = launchSync(offerCodeUntilPaired = true)

    /**
     * Starts sync mode in the background. The ticket is taken now, on the main thread: a stop that comes before
     * the start runs (leaving the app, locking, "Zakończ") cancels it.
     */
    private fun launchSync(offerCodeUntilPaired: Boolean) {
        val ticket = sync.startTicket()
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if (sync.start(ticket) && offerCodeUntilPaired && store.devices().isEmpty()) sync.offerPairing()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    // --- Lock and unlock --------------------------------------------------------------------------

    fun unlock(masterPassword: String) = launchVaultOperation("Odblokowuję…") {
        store.unlock(masterPassword)
        showList(null)
    }

    fun lock() = launchVaultOperation("Blokuję…") {
        sync.stop(null)
        store.lock()
        locks.onLockedByUser()
        _state.value = UiState(Screen.Locked)
    }

    /** "Usuń sejf z telefonu" (after the confirmation on screen): the entries stay only on the paired extensions. */
    fun disconnect() = launchVaultOperation("Usuwam sejf z telefonu…") {
        sync.stop(null)
        store.disconnect()
        // The vault is gone: whatever happens to the fingerprint key below, the start screen is the only right one.
        val warning = forgetFingerprint()?.let {
            Status("Usunięto sejf, ale nie udało się usunąć klucza odcisku palca: ${it.message ?: it.javaClass.simpleName}", isError = true)
        }
        _state.value = UiState(Screen.Start, status = warning)
    }

    /**
     * Turns fingerprint unlock off: the stored key belongs to the vault that is gone or replaced, and a vault
     * created later needs its own. Returns the error instead of throwing; the encrypted key is forgotten even then
     * (BiometricUnlock clears it before it deletes the Keystore key).
     */
    private fun forgetFingerprint(): Exception? = try {
        biometrics.disable()
        null
    } catch (e: Exception) {
        e
    }

    // --- Master password -------------------------------------------------------------------------

    fun openChangePassword() = _state.update { it.copy(screen = Screen.ChangePassword, status = null) }

    /**
     * "Zmień hasło": the same vault key wrapped with [newPassword] (security review I1). The phone forgets every
     * paired extension, so each one pairs again with the new password, and fingerprint unlock is turned off.
     */
    fun changeMasterPassword(oldPassword: String, newPassword: String, repeat: String) {
        if (oldPassword.isEmpty()) return fail("Podaj obecne hasło główne")
        MasterPasswordRules.problem(newPassword)?.let { return fail(it) }
        if (newPassword != repeat) return fail("Hasła się różnią")
        if (newPassword == oldPassword) return fail("Nowe hasło musi być inne niż obecne")
        launchVaultOperation("Liczę klucze z nowego hasła… (to celowo trwa kilka sekund)") {
            sync.stop(null)
            store.changeMasterPassword(oldPassword, newPassword)
            val hadFingerprint = biometrics.enabled.value
            val fingerprintError = forgetFingerprint()
            sync.refreshDevices()
            val text = buildString {
                append("Zmieniono hasło główne. Sparuj ponownie każdą wtyczkę i wpisz w niej nowe hasło.")
                if (hadFingerprint) append(" Odblokowanie odciskiem palca wyłączono, możesz je włączyć ponownie.")
                fingerprintError?.let { append(" Nie udało się usunąć klucza odcisku palca: ${it.message ?: it.javaClass.simpleName}") }
            }
            _state.update { it.copy(screen = Screen.Settings, status = Status(text, isError = fingerprintError != null)) }
        }
    }

    // --- Fingerprint ------------------------------------------------------------------------------

    fun biometricAvailability(): BiometricAvailability = app.fingerprintPrompt.availability(app)

    /** Called once by the locked screen when it appears: true means "open the fingerprint dialog now". */
    fun takeFingerprintOnLockedScreen(): Boolean = locks.takeFingerprintOffer(biometrics.enabled.value) && !store.isUnlocked

    /**
     * Turning fingerprint unlock on, step 1 (the vault is unlocked, list screen): the cipher the dialog must
     * unlock, or null if there is none (the reason is on the status line) or an operation is running.
     */
    fun cipherToEnableBiometric(): Cipher? = if (_state.value.busy) null else preparing(biometrics::cipherToEnable)

    /** Step 2: the finger confirmed it is the owner; [cipher] came back from the dialog. */
    fun onBiometricEnableAuthorized(cipher: Cipher) = launchVaultOperation("Włączam odcisk palca…") {
        store.exportUnlockKeys().useAndWipe { keys -> biometrics.enable(cipher, keys) }
        showStatus("Włączono odblokowanie odciskiem palca. Hasło główne nadal działa.")
    }

    fun disableBiometric() {
        biometrics.disable()
        showStatus("Wyłączono odblokowanie odciskiem palca.")
    }

    /** Unlocking with a fingerprint, step 1. Any problem leaves the master password field as the way in. */
    fun cipherToUnlockBiometric(): Cipher? =
        if (_state.value.busy || !biometrics.enabled.value) null else preparing(biometrics::cipherToUnlock)

    /** Step 2: [cipher] came back from the dialog. */
    fun onBiometricUnlockAuthorized(cipher: Cipher) = launchVaultOperation("Odblokowuję…") {
        biometrics.unlock(cipher, store::unlockWithKeys)
        showList(null)
    }

    /** The cipher from [prepare], or null with its error on the status line. */
    private fun preparing(prepare: () -> Cipher): Cipher? = try {
        prepare()
    } catch (e: Exception) {
        fail(e.message ?: e.javaClass.simpleName)
        null
    }

    // --- Entries ----------------------------------------------------------------------------------

    /** Re-reads the entries from the store (after a change made outside the screens). */
    fun reloadEntries() {
        viewModelScope.launch { refresh() }
    }

    fun selectTab(type: EntryType) = _state.update { it.copy(tab = type) }

    /** "+ Dodaj": an empty form for an entry of [type]. */
    fun newEntry(type: EntryType) {
        discardAddedInBackground()
        _state.update { it.copy(screen = Screen.Edit(null, type), editing = null, status = null) }
    }

    /**
     * The edit form for [id]. The entry is read from the store, off the main thread: the list on screen may
     * predate a sync, and saving its stale fields would overwrite the extension's change.
     */
    fun openEntry(id: String) {
        if (_state.value.busy) return
        viewModelScope.launch {
            val read = withContext(Dispatchers.IO) { runCatching { store.entry(id) } }
            val entry = read.getOrElse { return@launch fail(it.message ?: it.javaClass.simpleName) }
            if (entry == null) {
                refresh()
                return@launch fail("Tego wpisu już nie ma na telefonie.")
            }
            discardAddedInBackground()
            // Not if the vault locked or the screen changed in the meantime.
            _state.update {
                if (store.isUnlocked && it.screen == Screen.List) {
                    it.copy(screen = Screen.Edit(id, EntryType.of(entry.content.fields)), editing = entry, status = null)
                } else {
                    it
                }
            }
        }
    }

    /** Back to the list, on the tab of the entry that was being edited (or the tab it was on). */
    fun backToList() {
        // A vault operation is running (e.g. saving the files of this form): leaving now would discard them.
        if (_state.value.busy) return
        discardAddedInBackground()
        _state.update { it.copy(screen = Screen.List, status = null, editing = null, tab = it.returnTab()) }
    }

    fun openSettings() = _state.update { it.copy(screen = Screen.Settings, status = null) }

    /**
     * "Zapisz" on the form. [original] is the content the form was opened with (null for a new entry): only the
     * values changed against it are format-checked.
     */
    fun save(id: String?, content: EntryContentV3, original: EntryContentV3?) {
        val tidy = tidyContent(content)
        validateContent(tidy, original)?.let { return fail(it) }
        launchVaultOperation("Zapisuję…") {
            try {
                store.upsertContent(id ?: UUID.randomUUID().toString(), tidy)
            } catch (e: EntryTooLargeException) {
                return@launchVaultOperation fail("Wpis jest za duży")
            } catch (e: EntryTypeMismatchException) {
                return@launchVaultOperation fail("Ten wpis ma inny typ")
            }
            // Files added in this form and removed from it before saving belong to no entry.
            discardAdded(keep = tidy.attachments.mapTo(HashSet()) { it.id })
            showList(SAVED, EntryType.of(tidy.fields))
        }
    }

    fun delete(id: String) {
        val tab = _state.value.returnTab()
        launchVaultOperation("Usuwam…") {
            store.delete(id)
            discardAdded()
            showList(DELETED, tab)
        }
    }

    /**
     * Copies a field of an entry. A [sensitive] one (password, TOTP, card number…) is marked sensitive and the
     * clipboard is cleared after [SecureClipboard.CLEAR_AFTER_MINUTES]. [label] is a copy noun ("hasło", "numer
     * karty"…), used as given in the status.
     */
    fun copy(label: String, value: String, sensitive: Boolean) {
        if (value.isEmpty()) return
        if (sensitive) {
            SecureClipboard.copyPassword(app, label, value)
            showStatus("Skopiowano $label. Schowek zostanie wyczyszczony za ${SecureClipboard.CLEAR_AFTER_MINUTES} min.")
        } else {
            SecureClipboard.copyText(app, label, value)
            showStatus("Skopiowano $label.")
        }
    }

    // --- Attachments ------------------------------------------------------------------------------

    /** Ids of the files added in the form now open: encrypted on disk already, in no saved entry yet. */
    private val addedFiles = java.util.Collections.synchronizedSet(HashSet<String>())

    /**
     * The file chosen for "+ Dodaj plik", or null when the picker was cancelled. The file is read and encrypted
     * straight onto the disk; [onAdded] gets its descriptor on the main thread. [count] is how many files the
     * form has already.
     */
    fun attachFile(uri: Uri?, count: Int, onAdded: (Attachment) -> Unit) {
        endFilePick()
        // The vault may have locked while the picker was open: the file is not even read then.
        if (uri == null || !store.isUnlocked) return
        if (!Attachments.canAdd(count)) return fail(AttachmentFiles.TOO_MANY)
        launchVaultOperation("Szyfruję plik…") {
            val picked = AttachmentFiles.read(app.contentResolver, uri)
            val attachment = try {
                store.addFile(picked.bytes, picked.name, picked.mime)
            } finally {
                picked.bytes.fill(0)
            }
            addedFiles.add(attachment.id)
            _state.update { it.copy(status = null) }
            viewModelScope.launch { onAdded(attachment) }
        }
    }

    /** The ids of the [attachments] that are complete on the phone; a file that cannot be checked counts as not ready. */
    suspend fun fileReady(attachments: List<Attachment>): Set<String> = withContext(Dispatchers.IO) {
        attachments.filter { runCatching { store.isFileComplete(it) }.getOrDefault(false) }.mapTo(HashSet()) { it.id }
    }

    /** The document created for "Pobierz", or null when the save dialog was cancelled. Writes the decrypted file there. */
    fun downloadFile(a: Attachment, uri: Uri?) {
        endFilePick()
        if (uri == null || !store.isUnlocked) return
        launchVaultOperation("Odszyfrowuję plik…") {
            val bytes = try {
                store.readFile(a)
            } catch (_: IllegalArgumentException) {
                throw IllegalArgumentException(AttachmentFiles.CORRUPTED)
            } catch (_: IOException) {
                throw IOException(AttachmentFiles.VAULT_READ_FAILED)
            }
            try {
                AttachmentFiles.write(app.contentResolver, uri, bytes)
            } finally {
                bytes.fill(0)
            }
            showStatus("Zapisano plik ${a.name}.")
        }
    }

    /** Takes the ids of the files added in this form out of [addedFiles], except the [keep] ones (saved in the entry). */
    private fun takeAdded(keep: Set<String> = emptySet()): Set<String> =
        synchronized(addedFiles) { (addedFiles - keep).also { addedFiles.clear() } }

    /** Deletes [ids] (blocking). A failure goes to the log and the ids are kept for a later discard. */
    private fun discardFiles(ids: Set<String>) {
        if (ids.isEmpty()) return
        try {
            store.discardFiles(ids)
        } catch (e: Exception) {
            Log.w(TAG, "Could not discard files added to a form", e)
            synchronized(addedFiles) { addedFiles.addAll(ids) }
        }
    }

    /** Blocking: for code already off the main thread. */
    private fun discardAdded(keep: Set<String> = emptySet()) = discardFiles(takeAdded(keep))

    /** The ids are taken now, the files deleted off the main thread. */
    private fun discardAddedInBackground() {
        val ids = takeAdded()
        if (ids.isEmpty()) return
        viewModelScope.launch { withContext(Dispatchers.IO) { discardFiles(ids) } }
    }

    // --- Import and export -------------------------------------------------------------------------

    /** ⋮ → "Import i eksport". */
    fun openTransfer() = _state.update { it.copy(screen = Screen.Transfer, status = null) }

    /** Called just before the system file picker is launched: that trip out of the app gets 60 s (see [LockController]). */
    fun beginFilePick() = locks.expectFilePicker()

    /** The picker returned or could not be launched: its 60 s window ends. */
    fun endFilePick() = locks.filePickerClosed()

    /**
     * The file chosen for "Importuj plik", or null when the picker was cancelled (nothing to say then). The format
     * is recognised from the content: a ZIP (first 4 bytes) is read as a PassHolder ZIP, streamed with its files;
     * anything else as text. Entries already in the vault with the same content are skipped.
     */
    fun importFrom(uri: Uri?) {
        endFilePick()
        // The vault may have locked while the picker was open: the file is not even read then.
        if (uri == null || !store.isUnlocked) return
        launchVaultOperation("Importuję…") {
            val resolver = app.contentResolver
            val summary = if (TransferFiles.isZip(resolver, uri)) {
                val (parsed, result) = TransferFiles.openArchive(resolver, uri).use { store.importArchive(it) }
                importSummary(parsed, result.entries, TransferFormat.PASSHOLDER, ArchiveFiles(result.filesAdded, result.fileSkips))
            } else {
                val text = TransferFiles.readText(resolver, uri)
                val (format, parsed) = Transfer.parseImportFile(text)
                val result = store.importContents(parsed.entries)
                // A bare passholder.json taken out of an archive: its files are listed as skipped.
                importSummary(parsed, result, format, ArchiveFiles(0, parsed.files))
            }
            showStatus(summary)
            viewModelScope.launch { refresh() }
        }
    }

    /** The document created for "Zapisz plik", or null when the save dialog was cancelled. */
    fun exportTo(format: TransferFormat, uri: Uri?) {
        endFilePick()
        if (uri == null || !store.isUnlocked) return
        launchVaultOperation("Zapisuję plik…") {
            TransferFiles.writeText(app.contentResolver, uri, Transfer.exportFile(format, store.allContents()))
            showStatus("Zapisano plik. Usuń go zaraz po użyciu, zawiera hasła jawnym tekstem.")
        }
    }

    /**
     * The document created for "Zapisz plik" with PassHolder ZIP chosen, or null when the save dialog was cancelled.
     * The entries and their decrypted files are streamed into it, one file in memory at a time; a file that is not
     * complete on the phone (waiting for sync) or cannot be decrypted is left out and counted.
     */
    fun exportArchiveTo(uri: Uri?) {
        endFilePick()
        if (uri == null || !store.isUnlocked) return
        launchVaultOperation("Przygotowuję archiwum…") {
            val entries = store.allContents()
            val out = TransferFiles.writeArchive(app.contentResolver, uri) { stream ->
                PassHolderZip.export(entries, stream, ::readForExport)
            }
            showStatus(
                listOfNotNull(
                    if (out.files > 0) "Wyeksportowano ${entriesNoun(entries.size)} i ${filesNoun(out.files)}." else "Wyeksportowano ${entriesNoun(entries.size)}.",
                    if (out.missing > 0) missingFilesSentence(out.missing) else null,
                    "Usuń archiwum, gdy nie będzie już potrzebne.",
                ).joinToString(" "),
            )
        }
    }

    /**
     * A file's decrypted bytes for the archive, or null when it is not complete or cannot be read (counted as missing).
     * The vault locking (IllegalStateException) is not a missing file: it ends the export.
     */
    private fun readForExport(a: Attachment): ByteArray? = try {
        if (store.isFileComplete(a)) store.readFile(a) else null
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: IOException) {
        null
    }

    // --- Sync mode and devices -----------------------------------------------------------------------

    /** "Synchronizacja": sync mode, where the extension can reach the phone. */
    fun openSync() {
        _state.update { it.copy(screen = Screen.Sync, status = null) }
        startSync()
    }

    /**
     * Sync mode again after it turned itself off (idle, leaving the app), or after a failed start ("Włącz
     * ponownie"). On the restore screen it also brings a new code.
     */
    fun startSync() {
        _state.update { it.copy(status = null) }
        launchSync(offerCodeUntilPaired = _state.value.screen == Screen.Restore)
    }

    /** "Zakończ": the server stops, back to the list. */
    fun closeSync() {
        sync.stop(null)
        backToList()
        viewModelScope.launch { refresh() }
    }

    /** "Dodaj wtyczkę" (and "Nowy kod" while restoring): a new 8-digit pairing code for 2 minutes. */
    fun addExtension() {
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { sync.offerPairing() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    /** For the countdown on screen: milliseconds left on [offer]; drops the code once it can no longer be used. */
    fun pairingCodeRemainingMs(offer: PairingOffer): Long {
        sync.refreshOffer()
        return sync.remainingMs(offer)
    }

    fun openDevices() {
        sync.refreshDevices()
        _state.update { it.copy(screen = Screen.Devices, status = null) }
    }

    /** "Usuń" on Urządzenia (after the confirmation): the extension can no longer sync. */
    fun removeDevice(id: String) {
        val name = store.devices().firstOrNull { it.deviceId == id }?.name ?: return
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { store.removeDevice(id) }
                sync.refreshDevices()
                showStatus("Usunięto urządzenie $name.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    var generatorOptions: GeneratorOptions
        get() = app.settings.generatorOptions
        set(value) { app.settings.generatorOptions = value }

    /** Drops the status line when it shows an error, so a fixed field does not keep its stale message. */
    fun clearError() = _state.update { if (it.status?.isError == true) it.copy(status = null) else it }

    fun fail(message: String) = _state.update { it.copy(status = Status(message, isError = true)) }

    // --- Helpers ----------------------------------------------------------------------------------

    private fun showStatus(text: String) = _state.update { it.copy(status = Status(text)) }

    private fun showList(message: String?, tab: EntryType = EntryType.LOGIN) {
        _state.value = UiState(
            Screen.List,
            entries = store.entries(),
            unreadable = store.unreadableIds().size,
            status = message?.let { Status(it) },
            tab = tab,
        )
    }

    /** The list for a vault unlocked elsewhere; the entries are read off the main thread, the locked screen stays until then. */
    private fun showListUnlockedElsewhere() {
        viewModelScope.launch {
            val read = withContext(Dispatchers.IO) { runCatching { store.entries() to store.unreadableIds().size } }
            read.onSuccess { (entries, unreadable) ->
                if (store.isUnlocked && _state.value.screen == Screen.Locked && !_state.value.busy) {
                    _state.value = UiState(Screen.List, entries = entries, unreadable = unreadable)
                }
            }
        }
    }

    /** The tab the list comes back to: the edited entry's type, otherwise the current tab. */
    private fun UiState.returnTab(): EntryType = (screen as? Screen.Edit)?.type ?: tab

    /**
     * Reads the entries off the main thread (decrypting every record). Does nothing if the vault locked meanwhile:
     * decrypted entries never go into the state of a locked screen.
     */
    private suspend fun refresh() {
        if (!store.isUnlocked) return
        val read = withContext(Dispatchers.IO) { runCatching { store.entries() to store.unreadableIds().size } }
        read.onSuccess { (entries, unreadable) ->
            _state.update { if (store.isUnlocked) it.copy(entries = entries, unreadable = unreadable) else it }
        }
    }

    /** Runs a blocking vault operation off the main thread, with a progress message and errors shown in the status line. */
    private fun launchVaultOperation(progress: String, action: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, status = Status(progress)) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { action() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(status = Status(e.message ?: e.javaClass.simpleName, isError = true)) }
            } finally {
                _state.update { it.copy(busy = false) }
                locks.onOperationFinished()
            }
        }
    }

    private companion object {
        const val TAG = "AppViewModel"
        const val SAVED = "Zapisano na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji."
        const val DELETED = "Usunięto na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji."
    }
}
