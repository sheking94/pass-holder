package io.github.sheking94.passholder.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.sheking94.passholder.core.CertificatePin
import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.LocalEntry
import kotlinx.coroutines.Dispatchers
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
    data object Connect : Screen
    data object Locked : Screen
    data object List : Screen
    /** [id] is null for a new entry. */
    data class Edit(val id: String?) : Screen
}

data class Status(val text: String, val isError: Boolean = false)

data class UiState(
    val screen: Screen,
    val busy: Boolean = false,
    val status: Status? = null,
    val entries: List<LocalEntry> = emptyList(),
    val pending: Int = 0,
    /** Server address the user wants to pair with, and the fingerprint of its certificate, waiting for confirmation. */
    val pairing: Pairing? = null,
)

data class Pairing(val url: String, val fingerprint: String?)

/**
 * The single source of UI state. Every operation on the vault runs on Dispatchers.IO (Argon2id, disk,
 * network), one at a time; the screens only read [state] and call these functions.
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as PassHolderApp
    private val store = app.vaultStore

    private val _state = MutableStateFlow(UiState(initialScreen()))
    val state: StateFlow<UiState> = _state.asStateFlow()

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

    fun checkAutoLock() {
        val screen = _state.value.screen
        if (screen == Screen.Connect || screen == Screen.Locked || _state.value.busy) return
        viewModelScope.launch {
            if (withContext(Dispatchers.IO) { store.lockIfIdle() }) {
                _state.value = UiState(Screen.Locked, status = Status("Zablokowano po 15 minutach bezczynności."))
            }
        }
    }

    // --- Connecting -------------------------------------------------------------------------------

    /** Step 1 of pairing: read the server's certificate so the user can compare its fingerprint with the Pi. */
    fun inspectServer(rawUrl: String) {
        val url = rawUrl.trim().trimEnd('/')
        if (url.startsWith("http://") && BuildConfig.DEBUG) {
            _state.update { it.copy(pairing = Pairing(url, null), status = Status("Serwer deweloperski bez HTTPS (tylko wersja debug).")) }
            return
        }
        if (!url.startsWith("https://")) return fail("Podaj pełny adres, np. https://passholder.local:8443")
        run("Pobieram certyfikat serwera…") {
            val fingerprint = CertificatePin.fingerprint(CertificatePin.fetchServerCertificate(url))
            _state.update { it.copy(pairing = Pairing(url, fingerprint), status = null) }
        }
    }

    fun cancelPairing() = _state.update { it.copy(pairing = null, status = null) }

    /** Step 2: create a new vault on the server, or download the existing one. */
    fun connect(isNew: Boolean, setupToken: String, masterPassword: String) {
        val pairing = _state.value.pairing ?: return
        run("Liczę klucze z hasła głównego… (to celowo trwa kilka sekund)") {
            if (isNew) store.createVault(pairing.url, pairing.fingerprint, setupToken.trim(), masterPassword)
            else store.connectExisting(pairing.url, pairing.fingerprint, masterPassword)
            showList("Połączono z serwerem.")
        }
    }

    // --- Lock and unlock --------------------------------------------------------------------------

    fun unlock(masterPassword: String) = run("Odblokowuję…") {
        store.unlock(masterPassword)
        showList(null)
    }

    fun lock() = run("Blokuję…") {
        store.lock()
        _state.value = UiState(Screen.Locked)
    }

    fun disconnect() = run("Odłączam…") {
        store.disconnect()
        _state.value = UiState(Screen.Connect)
    }

    // --- Entries ----------------------------------------------------------------------------------

    fun openEntry(id: String?) = _state.update { it.copy(screen = Screen.Edit(id), status = null) }

    fun backToList() = _state.update { it.copy(screen = Screen.List, status = null) }

    fun save(id: String?, credentials: Credentials) {
        if (credentials.name.isBlank()) return fail("Podaj nazwę serwisu")
        if (credentials.password.isEmpty()) return fail("Podaj albo wygeneruj hasło")
        run("Zapisuję…") {
            store.upsert(id ?: UUID.randomUUID().toString(), credentials.copy(name = credentials.name.trim()))
            showList("Zapisano na telefonie. Zsynchronizuj, gdy serwer będzie włączony.")
        }
    }

    fun delete(id: String) = run("Usuwam…") {
        store.delete(id)
        showList("Usunięto na telefonie. Zsynchronizuj, żeby usunąć też na innych urządzeniach.")
    }

    fun sync() = run("Synchronizuję…") {
        store.sync()
        showList("Zsynchronizowano o ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())}.")
    }

    fun copy(text: String, what: String, sensitive: Boolean) {
        SecureClipboard.copy(app, what, text, sensitive)
        val suffix = if (sensitive) " Schowek zostanie wyczyszczony za ${SecureClipboard.CLEAR_AFTER_MINUTES} min." else ""
        _state.update { it.copy(status = Status("Skopiowano $what.$suffix")) }
    }

    var generatorOptions: GeneratorOptions
        get() = app.settings.generatorOptions
        set(value) { app.settings.generatorOptions = value }

    fun fail(message: String) = _state.update { it.copy(status = Status(message, isError = true)) }

    // --- Helpers ----------------------------------------------------------------------------------

    private fun showList(message: String?) {
        val pending = store.pendingCount()
        val text = message ?: if (pending > 0) "Niezsynchronizowane zmiany: $pending (oznaczone •)." else null
        _state.value = UiState(Screen.List, entries = store.entries(), pending = pending, status = text?.let { Status(it) })
    }

    private fun refresh() = _state.update { it.copy(entries = store.entries(), pending = store.pendingCount()) }

    /** Runs a blocking vault operation off the main thread, with a progress message and errors shown in the status line. */
    private fun run(progress: String, action: () -> Unit) {
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
            }
        }
    }
}
