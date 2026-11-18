package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.Screen

/**
 * Picks the screen from the state. No navigation library: a handful of screens are a `when`.
 * Each screen gets the state and only the groups of actions it uses (ScreenActions.kt).
 */
@Composable
fun PassHolderUi(vm: AppViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    PassHolderTheme {
        Surface(Modifier.fillMaxSize()) {
            Box(Modifier.safeDrawingPadding()) {
                when (val screen = state.screen) {
                    Screen.Start -> StartScreen(state, vm.vault)
                    Screen.Locked -> LockedScreen(state, vm.vault, vm.fingerprint)
                    Screen.List -> ListScreen(state, vm.navigation, vm.vault, vm.entries)
                    is Screen.Edit -> EditScreen(screen.id, screen.type, state, vm.navigation, vm.entries, vm.attachments)
                    Screen.Settings -> SettingsScreen(state, vm.navigation, vm.fingerprint, vm.settings)
                    Screen.ChangePassword -> ChangePasswordScreen(state, vm.navigation, vm.vault, vm.status)
                    Screen.Transfer -> TransferScreen(state, vm.navigation, vm.transfer)
                    Screen.Sync -> SyncScreen(state, vm.sync)
                    Screen.Devices -> DevicesScreen(state, vm.navigation, vm.sync)
                    Screen.Restore -> RestoreScreen(state, vm.vault, vm.sync)
                }
            }
        }
    }
}
