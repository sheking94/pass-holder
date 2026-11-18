package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.ui.Navigation
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Moving between the vault's screens. Leaving an entry form deletes the files added in it and not saved. */
internal class NavigationModel(
    private val ui: UiStateHolder,
    private val store: PhoneVaultStore,
    private val attachments: AttachmentsModel,
    private val sync: SyncModel,
) : Navigation {
    override fun backToList() {
        // A vault operation is running (e.g. saving the files of this form): leaving now would discard them.
        if (ui.busy) return
        attachments.discardAddedInBackground()
        ui.update { it.copy(screen = Screen.List, status = null, editing = null, tab = it.returnTab()) }
    }

    override fun openSettings() = show(Screen.Settings)

    override fun openChangePassword() = show(Screen.ChangePassword)

    override fun openTransfer() = show(Screen.Transfer)

    override fun openSync() {
        show(Screen.Sync)
        sync.startSync()
    }

    override fun openDevices() {
        sync.refreshDevices()
        show(Screen.Devices)
    }

    override fun selectTab(type: EntryType) = ui.update { it.copy(tab = type) }

    override fun newEntry(type: EntryType) {
        attachments.discardAddedInBackground()
        ui.update { it.copy(screen = Screen.Edit(null, type), editing = null, status = null) }
    }

    /** Off the main thread: saving the stale fields of the list on screen would overwrite the extension's change. */
    override fun openEntry(id: String) {
        if (ui.busy) return
        ui.scope.launch {
            val read = withContext(Dispatchers.IO) { runCatching { store.entry(id) } }
            val entry = read.getOrElse { return@launch ui.fail(errorMessage(it)) }
            if (entry == null) {
                ui.refresh()
                return@launch ui.fail("Tego wpisu już nie ma na telefonie.")
            }
            attachments.discardAddedInBackground()
            // Not if the vault locked or the screen changed in the meantime.
            ui.update {
                if (store.isUnlocked && it.screen == Screen.List) {
                    it.copy(screen = Screen.Edit(id, EntryType.of(entry.content.fields)), editing = entry, status = null)
                } else {
                    it
                }
            }
        }
    }

    private fun show(screen: Screen) = ui.update { it.copy(screen = screen, status = null) }
}
