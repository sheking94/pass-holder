package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
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
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.emptyContent
import io.github.sheking94.passholder.app.ui.forms.AttachmentsEditor
import io.github.sheking94.passholder.app.ui.forms.CardForm
import io.github.sheking94.passholder.app.ui.forms.ContactForm
import io.github.sheking94.passholder.app.ui.forms.CustomFieldsEditor
import io.github.sheking94.passholder.app.ui.forms.DocumentForm
import io.github.sheking94.passholder.app.ui.forms.LoginForm
import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.EntryFields
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields

/**
 * The entry form of every type: "Nazwa", the type's section, "Notatka" ("Treść" for a note), "Własne pola", "Załączniki",
 * Zapisz/Anuluj/Usuń. The form edits a copy of the whole content, so what it does not show is saved as it was.
 */
@Composable
fun EditScreen(
    id: String?,
    type: EntryType,
    state: UiState,
    navigation: Navigation,
    entries: EntryActions,
    attachments: AttachmentActions,
) {
    // Read from the store when the entry was opened (Navigation.openEntry), not from the list on screen.
    val original = remember(id, type) { state.editing?.takeIf { it.id == id }?.content }
    // remember, not rememberSaveable: entry secrets stay out of the saved instance state.
    var content by remember(id, type) { mutableStateOf(original ?: emptyContent(type)) }

    // Any edit drops an error status (e.g. "Ważność: wpisz MM/RR") left by an earlier save attempt.
    fun edit(updated: EntryContent) {
        content = updated
        entries.clearError()
    }
    var askDelete by remember { mutableStateOf(false) }

    // Stays enabled while busy (backToList ignores it then): a disabled handler would let Back close the app mid-operation.
    BackHandler(onBack = navigation::backToList)

    FormColumn {
        Text(if (original != null) type.editTitle else type.newTitle, style = MaterialTheme.typography.headlineSmall)
        PlainField(content.name, { edit(content.copy(name = it)) }, "Nazwa")

        TypeSection(content.fields, { edit(content.copy(fields = it)) }, entries)

        MultilineField(
            content.note,
            { edit(content.copy(note = it)) },
            if (type == EntryType.NOTE) "Treść" else "Notatka",
            minLines = if (type == EntryType.NOTE) 8 else 3,
        )
        CustomFieldsEditor(content.custom, { edit(content.copy(custom = it)) }, entries)
        AttachmentsEditor(content.attachments, { edit(content.copy(attachments = it)) }, attachments, state.busy)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { entries.save(id, content, original) }, enabled = !state.busy) { Text("Zapisz") }
            OutlinedButton(onClick = navigation::backToList, enabled = !state.busy) { Text("Anuluj") }
            if (original != null) {
                TextButton(onClick = { askDelete = true }, enabled = !state.busy) { Text("Usuń", color = MaterialTheme.colorScheme.error) }
            }
        }
        StatusLine(state.status, state.busy)
    }

    if (askDelete && id != null) {
        ConfirmDialog(
            "Po synchronizacji zniknie też z wtyczek.",
            onConfirm = { entries.delete(id) },
            onDismiss = { askDelete = false },
            title = "Usunąć wpis?",
        )
    }
}

/** The fields of the entry's type. A note has none of its own: its text is "Treść" of the form. */
@Composable
private fun TypeSection(fields: EntryFields, onChange: (EntryFields) -> Unit, entries: EntryActions) {
    when (fields) {
        is LoginFields -> LoginForm(fields, onChange, entries)
        is ContactFields -> ContactForm(fields, onChange)
        is CardFields -> CardForm(fields, onChange, entries)
        is DocumentFields -> DocumentForm(fields, onChange)
        NoteFields -> {}
    }
}
