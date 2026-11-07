package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.p2p.LocalAddresses
import io.github.sheking94.passholder.core.p2p.PairingOffer
import io.github.sheking94.passholder.core.p2p.PhoneSync
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import io.github.sheking94.passholder.core.p2p.StoredDevice
import io.github.sheking94.passholder.core.p2p.SyncHttpServer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.IOException
import java.net.BindException
import java.util.concurrent.atomic.AtomicLong

data class SyncUiState(
    val running: Boolean = false,
    /** Where the extension reaches the phone, `http://<IPv4>:<port>`. */
    val addresses: List<String> = emptyList(),
    /** The pairing code on screen; null when none was asked for or it can no longer be used. */
    val offer: PairingOffer? = null,
    /** "Sparowano: …" / "Zsynchronizowano z: …". */
    val lastEvent: String? = null,
    /** Why sync mode turned itself off (idle, leaving the app); null while it runs or after "Zakończ". */
    val stoppedReason: String? = null,
    /** A code was shown and has expired or was spent by a pairing attempt. */
    val offerSpent: Boolean = false,
    /** The paired extensions, as of the start of sync mode or its last request. */
    val devices: List<StoredDevice> = emptyList(),
)

/**
 * Sync mode: the phone's HTTP server for the extension, with pairing codes and the idle stop.
 * The server threads call back into here; [state] is a StateFlow, safe to update from any thread.
 */
class SyncController(
    private val store: PhoneVaultStore,
    private val port: Int,
    private val now: () -> Long = System::currentTimeMillis,
    /** The phone's addresses for the port actually bound (with [port] 0 the system picks one). */
    private val addresses: (boundPort: Int) -> List<String> = { LocalAddresses.list(it) },
    /** After each sync an extension finished (on a server thread): the vault on disk may have changed. */
    private val onSynced: () -> Unit = {},
) {
    companion object {
        const val IDLE_STOPPED = "Tryb synchronizacji wyłączony po 5 min bez połączeń."
        const val LEFT_APP_STOPPED = "Tryb synchronizacji wyłączony po wyjściu z aplikacji."
    }

    private val lock = Any()
    private var server: SyncHttpServer? = null
    /** How many times [stop] was called. Guarded by [lock]; see [startTicket]. */
    private var stops = 0L
    /** The devices as last seen, to tell a new pairing or sync apart. Guarded by [lock]. */
    private var known: Map<String, StoredDevice> = emptyMap()
    @Volatile
    private var currentAddresses: List<String> = emptyList()
    private val lastRequestAt = AtomicLong(0)

    private val _state = MutableStateFlow(SyncUiState())
    val state: StateFlow<SyncUiState> = _state.asStateFlow()

    val running: Boolean get() = synchronized(lock) { server != null }

    /**
     * Taken when sync mode is asked for (on the main thread), before [start] runs in the background: a [stop]
     * in between (leaving the app, locking, "Zakończ") makes that [start] do nothing, so no server is left
     * running behind a screen that already moved on.
     */
    fun startTicket(): Long = synchronized(lock) { stops }

    /**
     * Starts the server, unless it already runs or [stop] was called since [ticket] was taken. Returns true only
     * when it bound a new server. Throws IllegalStateException with a message for the user.
     */
    fun start(ticket: Long = startTicket()): Boolean {
        synchronized(lock) {
            if (server != null || ticket != stops) return false
            val router = store.router(onRequest = { lastRequestAt.set(now()) }, addresses = { currentAddresses })
            lateinit var http: SyncHttpServer
            http = SyncHttpServer(port, { path, body -> router.handle(path, body).also { afterRequest(http) } })
            val bound = try {
                http.start()
            } catch (e: BindException) {
                throw IllegalStateException("Nie mogę uruchomić synchronizacji: port $port jest zajęty.", e)
            } catch (e: IOException) {
                throw IllegalStateException("Nie mogę uruchomić synchronizacji: ${e.message ?: e.javaClass.simpleName}", e)
            }
            server = http
            currentAddresses = addresses(bound)
            lastRequestAt.set(now())
            val devices = store.devices()
            known = devices.associateBy { it.deviceId }
            _state.value = SyncUiState(running = true, addresses = currentAddresses, devices = devices)
            return true
        }
    }

    /**
     * Stops the server and drops the pairing code. [reason] is shown on screen; a stop with a reason does
     * nothing when sync mode is already off, so it does not replace an earlier reason.
     */
    fun stop(reason: String?) = synchronized(lock) {
        stops++
        val stopped = server
        server = null
        if (stopped == null && reason != null) return@synchronized
        stopped?.stop()
        store.cancelPairing()
        _state.update {
            SyncUiState(
                lastEvent = if (reason != null) it.lastEvent else null,
                stoppedReason = reason,
                devices = store.devices(),
            )
        }
    }

    /** "Dodaj wtyczkę": a new code (in restore mode while a restore is in progress). */
    fun offerPairing() {
        val offer = store.offerPairing()
        _state.update { it.copy(offer = offer, offerSpent = false) }
    }

    /**
     * Stops sync mode after [PhoneSync.SYNC_IDLE_MS] without a request; also notices an expired code.
     * Returns true when it stopped sync mode.
     */
    fun checkIdle(): Boolean {
        if (running && now() - lastRequestAt.get() >= PhoneSync.SYNC_IDLE_MS) {
            stop(IDLE_STOPPED)
            return true
        }
        refreshOffer()
        return false
    }

    /** Milliseconds left on the code on screen, by this controller's clock. */
    fun remainingMs(offer: PairingOffer): Long = (offer.expiresAt - now()).coerceAtLeast(0)

    /** Drops the code from the screen once it expired or a pairing attempt spent it. */
    fun refreshOffer() {
        val shown = _state.value.offer ?: return
        if (now() < shown.expiresAt && store.currentOffer()?.sid == shown.sid) return
        _state.update { if (it.offer?.sid == shown.sid) it.copy(offer = null, offerSpent = true) else it }
    }

    /** Re-reads the device list, e.g. after one was removed. */
    fun refreshDevices() {
        val devices = synchronized(lock) {
            store.devices().also { d -> known = d.associateBy { it.deviceId } }
        }
        _state.update { it.copy(devices = devices) }
    }

    /**
     * After every request to [http]: a new pairing or a finished sync shows up as [SyncUiState.lastEvent].
     * Ignored once [http] was stopped (a request still in flight must not touch the state of a later start).
     */
    private fun afterRequest(http: SyncHttpServer) {
        var synced = false
        synchronized(lock) {
            if (server !== http) return
            val devices = store.devices()
            var event: String? = null
            for (d in devices) {
                val before = known[d.deviceId]
                if (before == null || before.pairedAt != d.pairedAt) {
                    event = "Sparowano: ${d.name}"
                } else if (d.lastSyncAt != null && d.lastSyncAt != before.lastSyncAt) {
                    event = "Zsynchronizowano z: ${d.name}"
                    synced = true
                }
            }
            known = devices.associateBy { it.deviceId }
            _state.update { it.copy(devices = devices, lastEvent = event ?: it.lastEvent) }
        }
        refreshOffer()
        if (synced) onSynced()
    }
}
