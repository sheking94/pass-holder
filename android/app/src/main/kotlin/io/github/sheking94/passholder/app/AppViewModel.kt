package io.github.sheking94.passholder.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.sheking94.passholder.core.CertificatePin
import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.ServerPicker
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.LiveEntry
import kotlinx.coroutines.Dispatchers
import javax.crypto.Cipher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import java.text.DateFormat
import java.util.Date
import java.util.UUID

sealed interface Screen {
    /** The screens that show what is in the vault: they must not stay on screen once it locks. */
    val showsVault: Boolean get() = false

    data object Connect : Screen
    data object Locked : Screen
    data object List : Screen {
        override val showsVault get() = true
    }
    data object Addresses : Screen {
        override val showsVault get() = true
    }
    /** [id] is null for a new entry. */
    data class Edit(val id: String?) : Screen {
        override val showsVault get() = true
    }
}

data class Status(val text: String, val isError: Boolean = false)

data class UiState(
    val screen: Screen,
    val busy: Boolean = false,
    val status: Status? = null,
    val entries: List<LiveEntry> = emptyList(),
    val pending: Int = 0,
    /** Server addresses the user wants to pair with, and the fingerprint of its certificate, waiting for confirmation. */
    val pairing: Pairing? = null,
)

/**
 * [urls]: every address of the server, in the order typed. [fingerprint]: of the certificate read from
 * [certificateFrom], the first address that answered; null for a local http:// server (debug only).
 */
data class Pairing(val urls: List<String>, val fingerprint: String?, val certificateFrom: String? = null)

/**
 * The single source of UI state. Every operation on the vault runs on Dispatchers.IO (Argon2id, disk,
 * network), one at a time; the screens only read [state] and call these functions.
 * When the vault locks is decided by [LockController], fingerprint unlock by [BiometricController].
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as PassHolderApp
    private val store = app.vaultStore
    private val biometrics = BiometricController(app.biometric)

    private val _state = MutableStateFlow(UiState(initialScreen()))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val locks = LockController(
        store = store,
        leaveLock = { app.leaveLock },
        lockDelay = { app.settings.lockDelay },
        isBusy = { _state.value.busy },
        currentScreen = { _state.value.screen },
        showLocked = { status -> _state.value = UiState(Screen.Locked, status = status) },
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
        if (store.isUnlocked) refresh()
    }

    private fun initialScreen(): Screen = when {
        store.account() == null -> Screen.Connect
        store.isUnlocked -> Screen.List
        else -> Screen.Locked
    }

    fun touch() = store.touch()

    // --- Lock lifecycle (see LockController) ----------------------------------------------------

    /** MainActivity.onStop, unless it is only a rotation. */
    fun onLeftApp() = locks.onLeftApp()

    /** MainActivity.onStart. */
    fun onReturn() = locks.onReturn()

    fun checkAutoLock() {
        viewModelScope.launch { locks.checkIdle() }
    }

    fun setLockDelay(on: Boolean) {
        app.settings.lockDelay = on
        _lockDelay.value = on
    }

    override fun onCleared() = locks.onCleared()

    // --- Connecting -------------------------------------------------------------------------------

    /**
     * Step 1 of pairing: read the server's certificate so the user can compare its fingerprint with the Pi.
     * The certificate comes from the first address that answers; the other address (e.g. Tailscale while
     * the VPN is off) does not have to be reachable now. One pin covers both: it is the same certificate.
     */
    fun inspectServer(rawUrl: String, rawSecondUrl: String = "") {
        val urls = ServerPicker.normalize(listOf(rawUrl, rawSecondUrl))
        if (urls.isNotEmpty() && urls.all { it.startsWith("http://") } && BuildConfig.DEBUG) {
            _state.update { it.copy(pairing = Pairing(urls, null), status = Status("Serwer deweloperski bez HTTPS (tylko wersja debug).")) }
            return
        }
        val valid = runCatching { ServerPicker.validate(urls, https = true) }
        if (valid.isFailure) return fail(valid.exceptionOrNull()?.message ?: "Podaj pełny adres, np. https://passholder.local:8443")
        launchVaultOperation("Pobieram certyfikat serwera…") {
            // If no address answers, the error of the last one is shown.
            val (from, fingerprint) = ServerPicker.firstThatAnswers(urls, onAllFailed = { errors -> errors.last() }) { url ->
                url to CertificatePin.fingerprint(CertificatePin.fetchServerCertificate(url))
            }
            _state.update { it.copy(pairing = Pairing(urls, fingerprint, from), status = null) }
        }
    }

    fun cancelPairing() = _state.update { it.copy(pairing = null, status = null) }

    /** Step 2: create a new vault on the server, or download the existing one. */
    fun connect(isNew: Boolean, setupToken: String, masterPassword: String) {
        val pairing = _state.value.pairing ?: return
        launchVaultOperation("Liczę klucze z hasła głównego… (to celowo trwa kilka sekund)") {
            if (isNew) store.createVault(pairing.urls, pairing.fingerprint, setupToken.trim(), masterPassword)
            else store.connectExisting(pairing.urls, pairing.fingerprint, masterPassword)
            showList("Połączono z serwerem.")
        }
    }

    // --- Server addresses ------------------------------------------------------------------------

    fun openAddresses() = _state.update { it.copy(screen = Screen.Addresses, status = null) }

    fun serverUrls(): List<String> = store.account()?.serverUrls.orEmpty()

    /** Saves new addresses for the paired server; the certificate pin stays, so no new pairing is needed. */
    fun saveServerUrls(urls: List<String>) = launchVaultOperation("Zapisuję adresy…") {
        store.setServerUrls(urls)
        showList("Zapisano adresy serwera. Przy synchronizacji telefon sam wybierze ten, który odpowiada.")
    }

    // --- Lock and unlock --------------------------------------------------------------------------

    fun unlock(masterPassword: String) = launchVaultOperation("Odblokowuję…") {
        store.unlock(masterPassword)
        showList(null)
    }

    fun lock() = launchVaultOperation("Blokuję…") {
        store.lock()
        locks.onLockedByUser()
        _state.value = UiState(Screen.Locked)
    }

    fun disconnect() = launchVaultOperation("Odłączam…") {
        store.disconnect()
        // The stored keys belong to this vault; a vault connected later gets new ones.
        biometrics.disable()
        _state.value = UiState(Screen.Connect)
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
            showList("Zapisano na telefonie. Zsynchronizuj, gdy serwer będzie włączony.")
        }
    }

    fun delete(id: String) = launchVaultOperation("Usuwam…") {
        store.delete(id)
        showList("Usunięto na telefonie. Zsynchronizuj, żeby usunąć też na innych urządzeniach.")
    }

    fun sync() = launchVaultOperation("Synchronizuję…") {
        store.sync()
        showList("Zsynchronizowano o ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())}.")
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
        val pending = store.pendingCount()
        val text = message ?: if (pending > 0) "Niezsynchronizowane zmiany: $pending (oznaczone •)." else null
        _state.value = UiState(Screen.List, entries = store.entries(), pending = pending, status = text?.let { Status(it) })
    }

    private fun refresh() = _state.update { it.copy(entries = store.entries(), pending = store.pendingCount()) }

    /** Runs a blocking vault operation off the main thread, with a progress message and errors shown in the status line. */
    private fun launchVaultOperation(progress: String, action: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, status = Status(progress)) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { action() }
            } catch (e: Exception) {
                val message = when (e) {
                    is SerializationException -> "Nieoczekiwana odpowiedź serwera"
                    else -> e.message ?: e.javaClass.simpleName
                }
                _state.update { it.copy(status = Status(message, isError = true)) }
            } finally {
                _state.update { it.copy(busy = false) }
                locks.onOperationFinished()
            }
        }
    }
}
