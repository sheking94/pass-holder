package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
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
                "Co najmniej 12 znaków. Hasła głównego nie da się odzyskać: bez niego nie otworzysz sejfu.",
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
