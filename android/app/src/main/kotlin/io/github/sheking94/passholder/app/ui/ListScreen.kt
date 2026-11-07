package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.BiometricAvailability
import io.github.sheking94.passholder.app.UiState

@Composable
fun ListScreen(state: UiState, vm: AppViewModel) {
    var query by rememberSaveable { mutableStateOf("") }
    val rows = state.entries.filter {
        val c = it.credentials
        query.isBlank() || "${c.name} ${c.username}".contains(query.trim(), ignoreCase = true)
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(query, { query = it }, placeholder = { Text("Szukaj…") }, singleLine = true, modifier = Modifier.weight(1f))
            Button(onClick = { vm.openEntry(null) }, enabled = !state.busy) { Text("+ Dodaj") }
        }
        if (state.unreadable > 0) {
            Text(
                "Wpisów nie do odczytania: ${state.unreadable}. Zaszyfrował je inny klucz, np. wtyczka sparowana z innym sejfem.",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        LazyColumn(Modifier.weight(1f)) {
            if (rows.isEmpty()) {
                item { Text(if (query.isBlank()) "Brak wpisów. Dodaj pierwszy." else "Nic nie pasuje.", Modifier.padding(vertical = 16.dp)) }
            }
            items(rows, key = { it.id }) { entry ->
                val c = entry.credentials
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = !state.busy) { vm.openEntry(entry.id) }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(c.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(c.username, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(onClick = { vm.copyLogin(c.username) }) { Text("Login") }
                    TextButton(onClick = { vm.copyPassword(c.password) }) { Text("Hasło") }
                }
                HorizontalDivider()
            }
        }
        // Three buttons do not fit one row on a narrow phone: the last one moves to the next row.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = vm::openSync, enabled = !state.busy) { Text("Synchronizacja") }
            OutlinedButton(onClick = vm::openDevices, enabled = !state.busy) { Text("Urządzenia") }
            OutlinedButton(onClick = vm::lock, enabled = !state.busy) { Text("Zablokuj") }
        }
        FingerprintSetting(state, vm)
        LockDelaySetting(state, vm)
        StatusLine(state.status, state.busy)
    }
}

/** The switch that turns fingerprint unlock on and off. Hidden on phones without a strong fingerprint reader. */
@Composable
private fun FingerprintSetting(state: UiState, vm: AppViewModel) {
    val availability = remember { vm.biometricAvailability() }
    val enabled by vm.biometricEnabled.collectAsStateWithLifecycle()
    val fingerprint = rememberFingerprintDialog(vm)
    if (availability == BiometricAvailability.Unsupported && !enabled) return

    val canToggle = !state.busy && (enabled || availability == BiometricAvailability.Ready)
    // The whole row is the switch, so tapping the label works too.
    Row(
        Modifier.fillMaxWidth().toggleable(value = enabled, enabled = canToggle, role = Role.Switch) { on ->
            if (on) fingerprint.show("Włącz odblokowanie odciskiem palca", vm::cipherToEnableBiometric, vm::onBiometricEnableAuthorized)
            else vm.disableBiometric()
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Odblokowanie odciskiem palca", style = MaterialTheme.typography.bodyLarge)
            if (availability == BiometricAvailability.NoFingerprint && !enabled) {
                Text("Najpierw dodaj odcisk palca w ustawieniach telefonu.", style = MaterialTheme.typography.bodySmall)
            }
        }
        Switch(checked = enabled, onCheckedChange = null, enabled = canToggle)
    }
}

/** Leaving the app locks the vault after 60 s (on, default) or at once (off). */
@Composable
private fun LockDelaySetting(state: UiState, vm: AppViewModel) {
    val on by vm.lockDelay.collectAsStateWithLifecycle()
    Row(
        Modifier.fillMaxWidth().toggleable(value = on, enabled = !state.busy, role = Role.Switch) { vm.setLockDelay(it) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Blokuj dopiero po 60 s poza aplikacją", style = MaterialTheme.typography.bodyLarge)
            Text(
                if (on) "Krótkie wyjście (np. wklejenie hasła) nie blokuje sejfu." else "Sejf blokuje się od razu po wyjściu z aplikacji.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(checked = on, onCheckedChange = null, enabled = !state.busy)
    }
}
