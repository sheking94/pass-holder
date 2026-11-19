package io.github.sheking94.passholder.app.ui

import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
    UnlockForm(UiTexts.UNLOCK_TITLE, busy, status, fingerprint, onUnlock, onFingerprint) {
        TextButton(onClick = onCancel) { Text("Anuluj") }
    }
}
