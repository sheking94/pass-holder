package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.Status

/**
 * The unlock form of the locked app ([LockedScreen]) and of the autofill unlock ([AutofillUnlockScreen]): [title],
 * the master password, "Odblokuj" with [secondaryAction] beside it, "Odblokuj odciskiem palca" when [fingerprintOn],
 * and the status line. "Odblokuj" and the keyboard's Done do nothing while [busy].
 */
@Composable
fun UnlockForm(
    title: String,
    busy: Boolean,
    status: Status?,
    fingerprintOn: Boolean,
    onUnlock: (String) -> Unit,
    onFingerprint: () -> Unit,
    secondaryAction: @Composable () -> Unit,
) {
    // remember, not rememberSaveable: the master password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }
    val unlock = { if (!busy) onUnlock(password) }

    FormColumn {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        MasterPasswordField(password, { password = it }, onDone = unlock)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = unlock, enabled = !busy) { Text("Odblokuj") }
            secondaryAction()
        }
        if (fingerprintOn) {
            OutlinedButton(onClick = onFingerprint, enabled = !busy) { Text("Odblokuj odciskiem palca") }
        }
        StatusLine(status, busy)
    }
}
