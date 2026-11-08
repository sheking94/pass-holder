package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.emptyContent
import io.github.sheking94.passholder.app.loginCredentials
import io.github.sheking94.passholder.core.CharacterGroup
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.PasswordGenerator
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import kotlin.math.roundToInt

private val GROUP_LABELS = mapOf(
    CharacterGroup.LOWERCASE to "małe litery",
    CharacterGroup.UPPERCASE to "wielkie litery",
    CharacterGroup.DIGITS to "cyfry",
    CharacterGroup.SYMBOLS to "symbole",
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EditScreen(id: String?, state: UiState, vm: AppViewModel) {
    // Read from the store when the entry was opened (AppViewModel.openEntry), not from the list on screen.
    val original = remember(id) { state.editing?.takeIf { it.id == id }?.content }
    val existing = remember(id) { state.editing?.takeIf { it.id == id }?.loginCredentials() }
    // remember, not rememberSaveable: entry passwords stay out of the saved instance state.
    var name by remember(id) { mutableStateOf(existing?.name ?: "") }
    var username by remember(id) { mutableStateOf(existing?.username ?: "") }
    var password by remember(id) { mutableStateOf(existing?.password ?: "") }
    var revealed by remember(id) { mutableStateOf(false) }
    var askDelete by remember { mutableStateOf(false) }

    val saved = remember { vm.generatorOptions }
    var length by remember { mutableFloatStateOf(saved.length.toFloat()) }
    var groups by remember { mutableStateOf(saved.groups) }

    BackHandler(onBack = vm::backToList)

    FormColumn {
        Text(if (existing != null) "Edytuj wpis" else "Nowy wpis", style = MaterialTheme.typography.headlineSmall)
        PlainField(name, { name = it }, "Nazwa serwisu")
        PlainField(username, { username = it }, "Login")
        PasswordField(password, { password = it }, "Hasło", monospace = true, revealed = revealed, onRevealedChange = { revealed = it })

        Card {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Generator haseł", style = MaterialTheme.typography.titleSmall)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Długość: ${length.roundToInt()}")
                    Slider(
                        value = length,
                        onValueChange = { length = it },
                        valueRange = PasswordGenerator.MIN_LENGTH.toFloat()..PasswordGenerator.MAX_LENGTH.toFloat(),
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CharacterGroup.entries.forEach { group ->
                        FilterChip(
                            selected = group in groups,
                            onClick = { groups = if (group in groups) groups - group else groups + group },
                            label = { Text(GROUP_LABELS.getValue(group)) },
                        )
                    }
                }
                OutlinedButton(onClick = {
                    val options = GeneratorOptions(length.roundToInt(), groups)
                    runCatching { PasswordGenerator.generate(options) }
                        .onSuccess {
                            password = it
                            revealed = true
                            vm.generatorOptions = options
                        }
                        .onFailure { vm.fail(it.message ?: "Błąd generatora") }
                }) { Text("Generuj") }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.save(id, loginContent(original, name, username, password), original) }, enabled = !state.busy) { Text("Zapisz") }
            OutlinedButton(onClick = vm::backToList, enabled = !state.busy) { Text("Anuluj") }
            if (existing != null) {
                TextButton(onClick = { askDelete = true }, enabled = !state.busy) { Text("Usuń", color = MaterialTheme.colorScheme.error) }
            }
        }
        StatusLine(state.status, state.busy)
    }

    if (askDelete && id != null) {
        AlertDialog(
            onDismissRequest = { askDelete = false },
            title = { Text("Usunąć wpis?") },
            text = { Text("Po synchronizacji zniknie też z wtyczek.") },
            confirmButton = { TextButton(onClick = { askDelete = false; vm.delete(id) }) { Text("Usuń", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { askDelete = false }) { Text("Anuluj") } },
        )
    }
}

/**
 * The form's three login fields over [original] (or an empty login): its other fields (TOTP, URLs, apps, note,
 * custom fields) stay as they were. Temporary: the full login form replaces it.
 */
private fun loginContent(original: EntryContentV3?, name: String, username: String, password: String): EntryContentV3 {
    val base = original ?: emptyContent(EntryType.LOGIN)
    // Another type is passed on as it is: the vault refuses to turn it into a login.
    val fields = (base.fields as? LoginFields)?.copy(username = username, password = password) ?: base.fields
    return base.copy(name = name, fields = fields)
}
