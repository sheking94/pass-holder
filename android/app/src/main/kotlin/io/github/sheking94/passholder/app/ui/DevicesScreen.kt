package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.core.p2p.StoredDevice
import java.text.DateFormat
import java.util.Date

/** "Urządzenia": the paired extensions, each with its pairing and last sync time, and "Usuń". */
@Composable
fun DevicesScreen(state: UiState, navigation: Navigation, syncActions: SyncActions) {
    val sync by syncActions.state.collectAsStateWithLifecycle()
    var toRemove by remember { mutableStateOf<StoredDevice?>(null) }
    BackHandler(onBack = navigation::backToList)

    FormColumn {
        Text("Urządzenia", style = MaterialTheme.typography.headlineSmall)
        if (sync.devices.isEmpty()) {
            Text("Brak sparowanych wtyczek. Dodasz je w trybie „Synchronizacja”.", style = MaterialTheme.typography.bodyMedium)
        }
        sync.devices.forEach { device ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(device.name, style = MaterialTheme.typography.titleMedium)
                    Text("Sparowano: ${formatDate(device.pairedAt)}", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "Ostatnia synchronizacja: ${device.lastSyncAt?.let(::formatDate) ?: "jeszcze nie"}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                TextButton(onClick = { toRemove = device }, enabled = !state.busy) { Text("Usuń", color = MaterialTheme.colorScheme.error) }
            }
            HorizontalDivider()
        }
        OutlinedButton(onClick = navigation::backToList) { Text("Wróć") }
        StatusLine(state.status, state.busy)
    }

    toRemove?.let { device ->
        ConfirmDialog(
            "Usunąć urządzenie ${device.name}? Nie będzie mogło się synchronizować.",
            onConfirm = { syncActions.removeDevice(device.deviceId) },
            onDismiss = { toRemove = null },
        )
    }
}

private fun formatDate(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(ms))
