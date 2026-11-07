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

/** Picks the screen from the state. No navigation library: a handful of screens are a `when`. */
@Composable
fun PassHolderUi(viewModel: AppViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    PassHolderTheme {
        Surface(Modifier.fillMaxSize()) {
            Box(Modifier.safeDrawingPadding()) {
                when (val screen = state.screen) {
                    Screen.Start -> StartScreen(state, viewModel)
                    Screen.Locked -> LockedScreen(state, viewModel)
                    Screen.List -> ListScreen(state, viewModel)
                    is Screen.Edit -> EditScreen(screen.id, state, viewModel)
                    Screen.Sync -> SyncScreen(state, viewModel)
                    Screen.Devices -> DevicesScreen(state, viewModel)
                    Screen.Restore -> RestoreScreen(state, viewModel)
                }
            }
        }
    }
}
