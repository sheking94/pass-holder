package io.github.sheking94.passholder.app.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable

/**
 * A yes/no question before a step that cannot be undone: [text] (and [title] when given), "Anuluj" and
 * [confirmLabel] in the error colour. Both buttons and a tap outside close it; only the confirm button calls [onConfirm].
 */
@Composable
fun ConfirmDialog(text: String, onConfirm: () -> Unit, onDismiss: () -> Unit, title: String? = null, confirmLabel: String = "Usuń") {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = title?.let { { Text(it) } },
        text = { Text(text) },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                onConfirm()
            }) { Text(confirmLabel, color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Anuluj") } },
    )
}

/** "Usuń sejf z telefonu": the same question on the locked screen and for a damaged vault. */
@Composable
fun DisconnectDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    ConfirmDialog("Usunąć sejf z tego telefonu? Wpisy zostaną tylko na sparowanych wtyczkach.", onConfirm, onDismiss)
}
