package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.first
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState

/**
 * Unlocking works offline: the wrapped vault key and the encrypted vault are on the phone.
 * With fingerprint unlock on, the system dialog opens by itself; the master password always works too.
 */
@Composable
fun LockedScreen(state: UiState, vm: AppViewModel) {
    // remember, not rememberSaveable: the master password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }
    var askDisconnect by remember { mutableStateOf(false) }
    val unlock = { if (!state.busy) vm.unlock(password) }
    val biometricEnabled by vm.biometricEnabled.collectAsStateWithLifecycle()
    val activity = LocalActivity.current
    val fingerprint = rememberFingerprintDialog(vm)
    val unlockWithFinger = { fingerprint.show("Odblokuj PassHolder", vm::cipherToUnlockBiometric, vm::onBiometricUnlockAuthorized) }

    val timesLeftApp by vm.timesLeftApp.collectAsStateWithLifecycle()

    // On app start and on every return to the app. Waits until the activity is in front: the system dialog
    // cannot be shown by an activity that is still in the background.
    LaunchedEffect(timesLeftApp) {
        (activity as? LifecycleOwner)?.lifecycle?.currentStateFlow?.first { it.isAtLeast(Lifecycle.State.RESUMED) }
        if (vm.takeFingerprintOnLockedScreen()) unlockWithFinger()
    }

    FormColumn {
        Text("PassHolder jest zablokowany", style = MaterialTheme.typography.headlineSmall)
        PasswordField(password, { password = it }, "Hasło główne", onDone = unlock)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = unlock, enabled = !state.busy) { Text("Odblokuj") }
            TextButton(onClick = { askDisconnect = true }, enabled = !state.busy) { Text("Odłącz ten telefon") }
        }
        if (biometricEnabled) {
            OutlinedButton(onClick = { unlockWithFinger() }, enabled = !state.busy) { Text("Odblokuj odciskiem palca") }
        }
        StatusLine(state.status, state.busy)
    }

    if (askDisconnect) {
        AlertDialog(
            onDismissRequest = { askDisconnect = false },
            title = { Text("Odłączyć telefon?") },
            text = { Text("Usunie to sejf z telefonu (i odblokowanie odciskiem palca). Niezsynchronizowane zmiany przepadną; to, co jest na serwerze, zostaje.") },
            confirmButton = { TextButton(onClick = { askDisconnect = false; vm.disconnect() }) { Text("Odłącz", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { askDisconnect = false }) { Text("Anuluj") } },
        )
    }
}
