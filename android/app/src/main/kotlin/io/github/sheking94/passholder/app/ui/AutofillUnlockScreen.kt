package io.github.sheking94.passholder.app.ui

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
import io.github.sheking94.passholder.app.Status
import io.github.sheking94.passholder.app.UiTexts

/**
 * The screen behind the "Odblokuj PassHolder" suggestion: the master password, or the fingerprint when it is on.
 * "Anuluj" works also while an unlock runs.
 */
@Composable
fun AutofillUnlockScreen(
    busy: Boolean,
    status: Status?,
    fingerprint: Boolean,
    onUnlock: (String) -> Unit,
    onFingerprint: () -> Unit,
    onCancel: () -> Unit,
) {
    // remember, not rememberSaveable: the master password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }
    val unlock = { if (!busy) onUnlock(password) }

    FormColumn {
        Text(UiTexts.UNLOCK_TITLE, style = MaterialTheme.typography.headlineSmall)
        PasswordField(password, { password = it }, "Hasło główne", onDone = unlock)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = unlock, enabled = !busy) { Text("Odblokuj") }
            TextButton(onClick = onCancel) { Text("Anuluj") }
        }
        if (fingerprint) {
            OutlinedButton(onClick = onFingerprint, enabled = !busy) { Text("Odblokuj odciskiem palca") }
        }
        StatusLine(status, busy)
    }
}
