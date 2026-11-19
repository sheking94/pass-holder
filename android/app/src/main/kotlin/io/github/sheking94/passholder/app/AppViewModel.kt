package io.github.sheking94.passholder.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.sheking94.passholder.app.ui.AttachmentActions
import io.github.sheking94.passholder.app.ui.EntryActions
import io.github.sheking94.passholder.app.ui.FilePicks
import io.github.sheking94.passholder.app.ui.FingerprintActions
import io.github.sheking94.passholder.app.ui.Navigation
import io.github.sheking94.passholder.app.ui.SettingsActions
import io.github.sheking94.passholder.app.ui.StatusActions
import io.github.sheking94.passholder.app.ui.SyncActions
import io.github.sheking94.passholder.app.ui.TransferActions
import io.github.sheking94.passholder.app.ui.VaultActions
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * The single source of UI state, put together from its parts. Every operation on the vault runs on
 * Dispatchers.IO (Argon2id, disk), one at a time ([UiStateHolder.launchOperation]). The screens read [state] and
 * get only the groups of actions they use ([navigation], [vault], [entries]…), never this whole class.
 * Here: the parts wired together, and the activity's lifecycle (leaving and returning, the auto-lock timer).
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as PassHolderApp
    private val store = app.phoneStore
    private val biometrics = BiometricController(app.biometric)

    private val ui: UiStateHolder = UiStateHolder(store, viewModelScope, UiState(initialScreen(), corruptVault = store.corruptState)) {
        locks.onOperationFinished()
    }
    val state: StateFlow<UiState> = ui.state

    /** A sync may have changed entries: the list must not keep (and the edit form must not save over) older ones. */
    private val syncController: SyncController =
        SyncController(store, app.syncPort, { app.clock() }, app.syncAddresses, app.syncAllowsLocal, onSynced = ui::refreshInBackground)

    private val syncModel: SyncModel = SyncModel(ui, store, syncController, backToList = { navigation.backToList() })

    private val locks: LockController = LockController(
        store = store,
        leaveLock = { app.leaveLock },
        lockDelay = { app.settings.lockDelay },
        isBusy = { ui.busy },
        currentScreen = { ui.current.screen },
        showLocked = { status ->
            syncModel.stop()
            ui.replace(UiState(Screen.Locked, status = status))
        },
    )

    private val filePicks = object : FilePicks, StatusActions by ui {
        override fun beginFilePick() = locks.expectFilePicker()

        override fun endFilePick() = locks.filePickerClosed()
    }

    private val attachmentsModel: AttachmentsModel = AttachmentsModel(ui, store, app.contentResolver, filePicks)

    val status: StatusActions = ui
    val sync: SyncActions = syncModel
    val navigation: Navigation = NavigationModel(ui, store, attachmentsModel, syncModel)
    val vault: VaultActions = VaultModel(ui, store, syncModel, locks, biometrics)
    val fingerprint: FingerprintActions =
        FingerprintModel(ui, store, biometrics, locks, { app.fingerprintPrompt }, { app.fingerprintPrompt.availability(app) })
    val settings: SettingsActions = SettingsModel(app.settings) { app.autofillStatus }
    val entries: EntryActions =
        EntriesModel(ui, store, attachmentsModel, app, app.settings, { app.appTrust }, { app.installedApps })
    val attachments: AttachmentActions = attachmentsModel
    val transfer: TransferActions = TransferModel(ui, store, app.contentResolver, filePicks)

    init {
        // Auto-lock also while the app sits in the background, as long as the process lives.
        viewModelScope.launch {
            while (true) {
                delay(AUTO_LOCK_CHECK_MS)
                checkAutoLock()
            }
        }
        // The activity came back while the vault stayed unlocked (e.g. within the 60 s after Back).
        if (store.isUnlocked) ui.refreshInBackground()
    }

    private fun initialScreen(): Screen = when {
        store.restoreInProgress -> Screen.Restore
        !store.hasVault -> Screen.Start
        store.isUnlocked -> Screen.List
        else -> Screen.Locked
    }

    /** MainActivity.onUserInteraction: activity for the auto-lock. */
    fun touch() = store.touch()

    /** Re-reads the entries from the store (after a change made outside the screens). */
    fun reloadEntries() = ui.refreshInBackground()

    // --- Lock lifecycle (see LockController) ----------------------------------------------------

    /** MainActivity.onStop, unless it is only a rotation. Sync mode never runs without the app on screen. */
    fun onLeftApp() {
        syncModel.stopWithReason(SyncController.LEFT_APP_STOPPED)
        locks.onLeftApp()
    }

    /** MainActivity.onStart. A restore in progress gets its server (and a code) back at once. */
    fun onReturn() {
        locks.onReturn()
        if (ui.current.screen == Screen.Restore) syncModel.startRestoreSync()
        // Unlocked outside this screen (the autofill unlock screen) while the app showed the locked screen.
        if (ui.current.screen == Screen.Locked && !ui.busy && store.isUnlocked) {
            ui.showListUnlockedElsewhere()
        } // The autofill service may have saved a login in the background; an edit form already open is not reloaded.
        else if (store.isUnlocked) {
            ui.refreshInBackground()
        }
    }

    /** Every 15 s and on return: the 5-minute idle stop of sync mode, then the 15-minute auto-lock. */
    fun checkAutoLock() {
        if (syncModel.checkIdle()) ui.refreshInBackground()
        viewModelScope.launch { locks.checkIdle() }
    }

    override fun onCleared() {
        syncModel.stop()
        locks.onCleared()
    }

    private companion object {
        /** How often the auto-lock is checked while the process lives; same as IDLE_CHECK_INTERVAL_MS in the extension. */
        const val AUTO_LOCK_CHECK_MS = 15_000L
    }
}
