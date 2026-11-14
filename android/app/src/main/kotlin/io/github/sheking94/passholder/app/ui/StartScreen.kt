package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState

/** No vault on the phone yet: a new one, or the one the extension still has after the old phone was lost. */
@Composable
fun StartScreen(state: UiState, vm: AppViewModel) {
    if (state.corruptVault) return CorruptVault(state, vm)
    var restore by rememberSaveable { mutableStateOf(false) }
    // remember, not rememberSaveable: the master password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    val create = { if (!state.busy) vm.createVault(password, repeat) }

    FormColumn {
        Text("PassHolder", style = MaterialTheme.typography.headlineSmall)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(false to "Nowy sejf", true to "Odtwórz z wtyczki").forEachIndexed { i, (value, label) ->
                SegmentedButton(selected = restore == value, onClick = { restore = value }, shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
            }
        }

        if (!restore) {
            Text(
                "Sejf będzie na tym telefonie. Wtyczkę w przeglądarce sparujesz potem przyciskiem „Synchronizacja”.",
                style = MaterialTheme.typography.bodyMedium,
            )
            PasswordField(password, { password = it }, "Hasło główne")
            PasswordField(repeat, { repeat = it }, "Powtórz hasło główne", onDone = create)
            Text(
                "Co najmniej 12 znaków, bez popularnych haseł i prostych ciągów (np. zdanie z kilku słów). Hasła głównego nie da się odzyskać: bez niego nie otworzysz sejfu.",
                style = MaterialTheme.typography.bodySmall,
            )
            Button(onClick = create, enabled = !state.busy) { Text("Załóż sejf") }
        } else {
            Text("Gdy stary telefon zginął, a sejf jest jeszcze we wtyczce:", style = MaterialTheme.typography.bodyMedium)
            Text(
                "1. Rozpocznij odtwarzanie: telefon pokaże kod parowania.\n" +
                    "2. We wtyczce sparuj się z telefonem i wpisz kod. Wtyczka prześle sejf.\n" +
                    "3. Telefon poprosi o hasło główne i od tej chwili to on przechowuje sejf.\n" +
                    "4. Pozostałe wtyczki sparuj z nowym telefonem; ich zmiany też do niego trafią.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(onClick = vm::startRestore, enabled = !state.busy) { Text("Rozpocznij odtwarzanie") }
        }
        StatusLine(state.status, state.busy)
    }
}

/** host.json is damaged: the only way on is to remove what is left and then create or restore the vault. */
@Composable
private fun CorruptVault(state: UiState, vm: AppViewModel) {
    var askDisconnect by remember { mutableStateOf(false) }
    FormColumn {
        Text("PassHolder", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Nie mogę odczytać danych sejfu na telefonie. Możesz je usunąć i założyć sejf od nowa albo odtworzyć go z wtyczki.",
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(onClick = { askDisconnect = true }, enabled = !state.busy) { Text("Usuń sejf z telefonu") }
        StatusLine(state.status, state.busy)
    }
    if (askDisconnect) {
        AlertDialog(
            onDismissRequest = { askDisconnect = false },
            text = { Text("Usunąć sejf z tego telefonu? Wpisy zostaną tylko na sparowanych wtyczkach.") },
            confirmButton = { TextButton(onClick = { askDisconnect = false; vm.disconnect() }) { Text("Usuń", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { askDisconnect = false }) { Text("Anuluj") } },
        )
    }
}
