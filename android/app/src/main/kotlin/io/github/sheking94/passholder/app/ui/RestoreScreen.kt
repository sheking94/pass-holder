package io.github.sheking94.passholder.app.ui

import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.UiState

/**
 * "Odtwórz z wtyczki" in progress. The server runs from the start: the extension pairs with the code shown and
 * sends the vault; then the master password of that vault finishes the restore.
 */
@Composable
fun RestoreScreen(state: UiState, vault: VaultActions, syncActions: SyncActions) {
    val sync by syncActions.state.collectAsStateWithLifecycle()
    // remember, not rememberSaveable: the master password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }
    val finish = { if (!state.busy) vault.finishRestore(password) }
    val paired = sync.devices.firstOrNull()
    val received = sync.devices.any { it.lastSyncAt != null }

    FormColumn {
        Text("Odtwarzanie z wtyczki", style = MaterialTheme.typography.headlineSmall)
        if (!received) {
            Text(
                "1. We wtyczce wybierz parowanie z telefonem i wpisz adres telefonu.\n" +
                    "2. Wpisz we wtyczce kod parowania.\n" +
                    "3. Wtyczka prześle sejf; potem podasz tu jego hasło główne.",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (sync.running) {
                Addresses(sync)
                if (paired == null) {
                    PairingCode(sync, syncActions, newCodeHint = "Kod wygasł lub został użyty. Weź nowy kod.")
                    if (sync.offer == null) OutlinedButton(onClick = syncActions::addExtension, enabled = !state.busy) { Text("Nowy kod") }
                } else {
                    Text("Sparowano: ${paired.name}. Czekam, aż wtyczka prześle sejf…", fontWeight = FontWeight.SemiBold)
                }
            } else {
                sync.stoppedReason?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
                OutlinedButton(onClick = syncActions::startSync, enabled = !state.busy) { Text("Włącz ponownie") }
            }
        } else {
            Text(
                "Wtyczka przesłała sejf. Podaj jego hasło główne (to samo co we wtyczce); od tej chwili sejf przechowuje ten telefon.",
                style = MaterialTheme.typography.bodyMedium,
            )
            MasterPasswordField(password, { password = it }, onDone = finish)
            Button(onClick = finish, enabled = !state.busy) { Text("Zakończ odtwarzanie") }
        }
        OutlinedButton(onClick = vault::abortRestore, enabled = !state.busy) { Text("Przerwij odtwarzanie") }
        StatusLine(state.status, state.busy)
    }
}
