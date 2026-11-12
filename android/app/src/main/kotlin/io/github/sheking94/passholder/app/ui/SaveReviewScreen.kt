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
 * The login the system's save question is about, to check and edit before it goes into the vault (spec 5.4).
 * [title] is the decision for the current [draft]; the name is asked only for a new entry ([isNew]); [place] is
 * the site or the app, read-only. "Zapisz" needs [canSave]; "Anuluj" works always.
 */
@Composable
fun SaveReviewScreen(
    title: String,
    isNew: Boolean,
    draft: SaveDraft,
    place: String,
    canSave: Boolean,
    saving: Boolean,
    onDraftChange: (SaveDraft) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    FormColumn {
        Text("Zapisz w PassHolder", style = MaterialTheme.typography.headlineSmall)
        Text(title, style = MaterialTheme.typography.titleMedium)
        if (isNew) PlainField(draft.name, { onDraftChange(draft.copy(name = it)) }, "Nazwa")
        PlainField(draft.username, { onDraftChange(draft.copy(username = it)) }, "Login")
        PasswordField(draft.password, { onDraftChange(draft.copy(password = it)) }, "Hasło")
        Text(place, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onSave, enabled = canSave && !saving) { Text("Zapisz") }
            TextButton(onClick = onCancel) { Text("Anuluj") }
        }
        if (saving) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}
