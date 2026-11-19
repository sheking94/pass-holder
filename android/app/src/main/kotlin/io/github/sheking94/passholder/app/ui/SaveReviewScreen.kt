package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.autofill.SaveDraft

/**
 * What the review screen shows: [title] is the decision for the current [draft]; the name is asked only for a new
 * entry ([isNew]); [place] is the site or the app, read-only. "Zapisz" needs [canSave]; both buttons are off while [saving].
 */
data class SaveReviewUi(
    val title: String,
    val isNew: Boolean,
    val draft: SaveDraft,
    val place: String,
    val canSave: Boolean,
    val saving: Boolean,
)

/** The login the system's save question is about, to check and edit before it goes into the vault (spec 5.4). */
@Composable
fun SaveReviewScreen(ui: SaveReviewUi, onDraftChange: (SaveDraft) -> Unit, onSave: () -> Unit, onCancel: () -> Unit) {
    val draft = ui.draft
    FormColumn {
        Text("Zapisz w PassHolder", style = MaterialTheme.typography.headlineSmall)
        Text(ui.title, style = MaterialTheme.typography.titleMedium)
        if (ui.isNew) PlainField(draft.name, { onDraftChange(draft.copy(name = it)) }, "Nazwa")
        PlainField(draft.username, { onDraftChange(draft.copy(username = it)) }, "Login")
        SecretField(draft.password, { onDraftChange(draft.copy(password = it)) }, "Hasło")
        Text(ui.place, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onSave, enabled = ui.canSave && !ui.saving) { Text("Zapisz") }
            TextButton(onClick = onCancel, enabled = !ui.saving) { Text("Anuluj") }
        }
        if (ui.saving) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}
