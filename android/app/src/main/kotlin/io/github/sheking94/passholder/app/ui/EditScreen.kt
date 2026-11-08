package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.emptyContent
import io.github.sheking94.passholder.app.ui.forms.CardForm
import io.github.sheking94.passholder.app.ui.forms.ContactForm
import io.github.sheking94.passholder.app.ui.forms.CustomFieldsEditor
import io.github.sheking94.passholder.app.ui.forms.DocumentForm
import io.github.sheking94.passholder.app.ui.forms.LoginForm
import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields

/**
 * The entry form of every type: "Nazwa", the type's section, "Notatka" ("Treść" for a note), "Własne pola",
 * Zapisz/Anuluj/Usuń. The form edits a copy of the whole content, so what it does not show is saved as it was.
 */
@Composable
fun EditScreen(id: String?, type: EntryType, state: UiState, vm: AppViewModel) {
    // Read from the store when the entry was opened (AppViewModel.openEntry), not from the list on screen.
    val original = remember(id, type) { state.editing?.takeIf { it.id == id }?.content }
    // remember, not rememberSaveable: entry secrets stay out of the saved instance state.
    var content by remember(id, type) { mutableStateOf(original ?: emptyContent(type)) }
    var askDelete by remember { mutableStateOf(false) }

    BackHandler(onBack = vm::backToList)

    FormColumn {
        Text(if (original != null) type.editTitle else type.newTitle, style = MaterialTheme.typography.headlineSmall)
        PlainField(content.name, { content = content.copy(name = it) }, "Nazwa")

        when (val fields = content.fields) {
            is LoginFields -> LoginForm(fields, { content = content.copy(fields = it) }, vm)
            is ContactFields -> ContactForm(fields, { content = content.copy(fields = it) }, vm)
            is CardFields -> CardForm(fields, { content = content.copy(fields = it) }, vm)
            is DocumentFields -> DocumentForm(fields, { content = content.copy(fields = it) }, vm)
            // A note has no fields of its own: its text is "Treść" below.
            NoteFields -> {}
        }

        MultilineField(
            content.note,
            { content = content.copy(note = it) },
            if (type == EntryType.NOTE) "Treść" else "Notatka",
            minLines = if (type == EntryType.NOTE) 8 else 3,
        )
        CustomFieldsEditor(content.custom, { content = content.copy(custom = it) }, vm)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.save(id, content, original) }, enabled = !state.busy) { Text("Zapisz") }
            OutlinedButton(onClick = vm::backToList, enabled = !state.busy) { Text("Anuluj") }
            if (original != null) {
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
