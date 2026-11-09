package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState

/** The list's top bar: "Synchronizacja" at hand, the rarer actions under ⋮. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultTopBar(state: UiState, vm: AppViewModel) {
    var menuOpen by remember { mutableStateOf(false) }
    TopAppBar(
        title = { Text("PassHolder") },
        // PassHolderUi already keeps every screen out of the system bars.
        windowInsets = WindowInsets(0),
        actions = {
            TextButton(onClick = vm::openSync, enabled = !state.busy) { Text("Synchronizacja") }
            Box {
                IconButton(onClick = { menuOpen = true }, enabled = !state.busy, modifier = Modifier.semantics { contentDescription = "Więcej" }) {
                    Text("⋮", style = MaterialTheme.typography.titleLarge)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(text = { Text("Urządzenia") }, enabled = !state.busy, onClick = { menuOpen = false; vm.openDevices() })
                    DropdownMenuItem(text = { Text("Ustawienia") }, enabled = !state.busy, onClick = { menuOpen = false; vm.openSettings() })
                    DropdownMenuItem(text = { Text("Import i eksport") }, enabled = !state.busy, onClick = { menuOpen = false; vm.openTransfer() })
                    DropdownMenuItem(text = { Text("Zablokuj") }, enabled = !state.busy, onClick = { menuOpen = false; vm.lock() })
                }
            }
        },
    )
}
