package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import io.github.sheking94.passholder.app.MasterPasswordRules
import io.github.sheking94.passholder.app.UiState

/** "Zmień hasło główne" (from Ustawienia): the current password, the new one twice. "Anuluj" and back go to Ustawienia. */
@Composable
fun ChangePasswordScreen(state: UiState, navigation: Navigation, vault: VaultActions, status: StatusActions) {
    BackHandler(onBack = navigation::openSettings)
    // remember, not rememberSaveable: passwords must not end up in the saved instance state.
    var current by remember { mutableStateOf("") }
    var new by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    val change = { if (!state.busy) vault.changeMasterPassword(current, new, repeat) }

    FormColumn {
        Text("Zmień hasło główne", style = MaterialTheme.typography.headlineSmall)
        MasterPasswordField(current, {
            current = it
            status.clearError()
        }, "Obecne hasło główne")
        MasterPasswordField(new, {
            new = it
            status.clearError()
        }, "Nowe hasło główne")
        MasterPasswordField(repeat, {
            repeat = it
            status.clearError()
        }, "Powtórz nowe hasło", onDone = change)
        Text(
            "${MasterPasswordRules.HINT}. Wpisy zostają bez zmian.",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(
            "Po zmianie telefon zapomni sparowane wtyczki. W każdej wtyczce wybierz „Adresy telefonu” → " +
                "„Sparuj z innym telefonem / odtwórz telefon” i wpisz nowe hasło. Odblokowanie odciskiem palca " +
                "zostanie wyłączone, a PIN we wtyczce wyłączy się przy ponownym parowaniu.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(onClick = change, enabled = !state.busy) { Text("Zmień hasło") }
        OutlinedButton(onClick = navigation::openSettings, enabled = !state.busy) { Text("Anuluj") }
        StatusLine(state.status, state.busy)
    }
}
