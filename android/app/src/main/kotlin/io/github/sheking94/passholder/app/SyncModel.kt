package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.app.ui.SyncActions
import io.github.sheking94.passholder.core.p2p.PairingOffer
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext

/** The screens' side of sync mode ([SyncController] runs the server): starting it, codes, devices. */
internal class SyncModel(
    private val ui: UiStateHolder,
    private val store: PhoneVaultStore,
    private val controller: SyncController,
    /** "Zakończ" goes back to the list (see NavigationModel). */
    private val backToList: () -> Unit,
) : SyncActions {
    override val state: StateFlow<SyncUiState> = controller.state

    /** The server stops and the pairing code is dropped (see [SyncController.stop]). */
    fun stop() = controller.stop()

    /** As [stop], with [reason] shown on screen (see [SyncController.stopWithReason]). */
    fun stopWithReason(reason: String) = controller.stopWithReason(reason)

    fun refreshDevices() = controller.refreshDevices()

    /** After an idle stop the entries may have changed meanwhile; true when it stopped sync mode. */
    fun checkIdle(): Boolean = controller.checkIdle()

    /**
     * Restore mode: the server runs from the start and, until an extension paired, a fresh server comes with a
     * fresh code. A server that was already running (e.g. after a rotation) keeps its code, or its
     * "Kod wygasł…" hint.
     */
    fun startRestoreSync() = launch(offerCodeUntilPaired = true)

    override fun startSync() {
        ui.update { it.copy(status = null) }
        launch(offerCodeUntilPaired = ui.current.screen == Screen.Restore)
    }

    override fun closeSync() {
        controller.stop()
        backToList()
        ui.refreshInBackground()
    }

    override fun addExtension() = ui.launchCatching { withContext(Dispatchers.IO) { controller.offerPairing() } }

    override fun pairingCodeRemainingMs(offer: PairingOffer): Long {
        controller.refreshOffer()
        return controller.remainingMs(offer)
    }

    override fun removeDevice(id: String) {
        val name = store.devices().firstOrNull { it.deviceId == id }?.name ?: return
        ui.launchCatching {
            withContext(Dispatchers.IO) { store.removeDevice(id) }
            controller.refreshDevices()
            ui.showStatus("Usunięto urządzenie $name.")
        }
    }

    /**
     * Starts sync mode in the background. The ticket is taken now, on the main thread: a stop that comes before
     * the start runs (leaving the app, locking, "Zakończ") cancels it.
     */
    private fun launch(offerCodeUntilPaired: Boolean) {
        val ticket = controller.startTicket()
        ui.launchCatching {
            withContext(Dispatchers.IO) {
                if (controller.start(ticket) && offerCodeUntilPaired && store.devices().isEmpty()) controller.offerPairing()
            }
        }
    }
}
