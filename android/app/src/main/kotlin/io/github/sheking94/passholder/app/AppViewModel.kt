package io.github.sheking94.passholder.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.p2p.PairingOffer
import io.github.sheking94.passholder.core.p2p.PhoneEntry
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
    /** [id] is null for a new entry. */
    data class Edit(val id: String?) : Screen {
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

    private val _state = MutableStateFlow(UiState(initialScreen()))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val sync = SyncController(store, app.syncPort, { app.clock() }, app.syncAddresses)
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
    }

    /** Every 15 s and on return: the 5-minute idle stop of sync mode, then the 15-minute auto-lock. */
    fun checkAutoLock() {
        sync.checkIdle()
        viewModelScope.launch { locks.checkIdle() }
    }

    fun setLockDelay(on: Boolean) {
        app.settings.lockDelay = on
        _lockDelay.value = on
    }

    override fun onCleared() {
        sync.stop(null)
        locks.onCleared()
    }

    // --- Start ---------------------------------------------------------------------------------------

    /** "Nowy sejf": the same rules for the master password as the extension. */
    fun createVault(masterPassword: String, repeat: String) {
        if (masterPassword.length < MIN_MASTER_PASSWORD) return fail("Hasło główne musi mieć co najmniej $MIN_MASTER_PASSWORD znaków")
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

    // --- Fingerprint ------------------------------------------------------------------------------

    fun biometricAvailability(): BiometricAvailability = app.fingerprintPrompt.availability(app)

    /** Called once by the locked screen when it appears: true means "open the fingerprint dialog now". */
    fun takeFingerprintOnLockedScreen(): Boolean = locks.takeFingerprintOffer(biometrics.enabled.value)

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

    fun openEntry(id: String?) = _state.update { it.copy(screen = Screen.Edit(id), status = null) }

    fun backToList() = _state.update { it.copy(screen = Screen.List, status = null) }

    fun save(id: String?, credentials: Credentials) {
        if (credentials.name.isBlank()) return fail("Podaj nazwę serwisu")
        if (credentials.password.isEmpty()) return fail("Podaj albo wygeneruj hasło")
        launchVaultOperation("Zapisuję…") {
            store.upsert(id ?: UUID.randomUUID().toString(), credentials.copy(name = credentials.name.trim()))
            showList(SAVED)
        }
    }

    fun delete(id: String) = launchVaultOperation("Usuwam…") {
        store.delete(id)
        showList(DELETED)
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

    fun copyLogin(username: String) {
        SecureClipboard.copyText(app, "login", username)
        showStatus("Skopiowano login.")
    }

    fun copyPassword(password: String) {
        SecureClipboard.copyPassword(app, "hasło", password)
        showStatus("Skopiowano hasło. Schowek zostanie wyczyszczony za ${SecureClipboard.CLEAR_AFTER_MINUTES} min.")
    }

    var generatorOptions: GeneratorOptions
        get() = app.settings.generatorOptions
        set(value) { app.settings.generatorOptions = value }

    fun fail(message: String) = _state.update { it.copy(status = Status(message, isError = true)) }

    // --- Helpers ----------------------------------------------------------------------------------

    private fun showStatus(text: String) = _state.update { it.copy(status = Status(text)) }

    private fun showList(message: String?) {
        _state.value = UiState(Screen.List, entries = store.entries(), unreadable = store.unreadableIds().size, status = message?.let { Status(it) })
    }

    /** Reads the entries off the main thread (decrypting every record). Does nothing if the vault locked meanwhile. */
    private suspend fun refresh() {
        val read = withContext(Dispatchers.IO) { runCatching { store.entries() to store.unreadableIds().size } }
        read.onSuccess { (entries, unreadable) -> _state.update { it.copy(entries = entries, unreadable = unreadable) } }
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
        const val MIN_MASTER_PASSWORD = 12
        const val SAVED = "Zapisano na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji."
        const val DELETED = "Usunięto na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji."
    }
}
