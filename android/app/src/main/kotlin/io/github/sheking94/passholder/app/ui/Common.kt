package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.Status

private val Navy = Color(0xFF1E3A5F)

@Composable
fun PassHolderTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) {
        darkColorScheme(primary = Color(0xFF9CC3F0))
    } else {
        lightColorScheme(primary = Navy)
    }
    MaterialTheme(colorScheme = colors, content = content)
}

/** A scrollable form column that moves up with the keyboard. */
@Composable
fun FormColumn(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
fun StatusLine(status: Status?, busy: Boolean) {
    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (status != null) {
        Text(
            status.text,
            color = if (status.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

/**
 * Password field. KeyboardType.Password also when shown, so the keyboard does not learn or suggest it.
 * [revealed] lets the caller show a freshly generated password.
 */
@Composable
fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    monospace: Boolean = false,
    revealed: Boolean = false,
    onRevealedChange: ((Boolean) -> Unit)? = null,
    onDone: (() -> Unit)? = null,
) {
    var localRevealed by remember { mutableStateOf(false) }
    val shown = if (onRevealedChange != null) revealed else localRevealed
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        modifier = modifier.fillMaxWidth(),
        textStyle = if (monospace) MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
        visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Password,
            autoCorrectEnabled = false,
            imeAction = if (onDone != null) ImeAction.Done else ImeAction.Next,
        ),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        trailingIcon = {
            TextButton(onClick = { if (onRevealedChange != null) onRevealedChange(!shown) else localRevealed = !shown }) {
                Text(if (shown) "Ukryj" else "Pokaż")
            }
        },
    )
}

/**
 * A secret of an entry (password, TOTP, card number, hidden custom field): masked, "Pokaż/Ukryj" and "Kopiuj".
 * The keyboard stays in [keyboardType] (Password by default) also when shown, so it does not learn the value.
 * Pass [revealed] and [onRevealedChange] to show it from outside (a generated password) or to mask it again.
 */
@Composable
fun SecretField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    onCopy: () -> Unit,
    monospace: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Password,
    revealed: Boolean? = null,
    onRevealedChange: ((Boolean) -> Unit)? = null,
) {
    var localRevealed by remember { mutableStateOf(false) }
    val shown = revealed ?: localRevealed
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        textStyle = fieldTextStyle(monospace),
        visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        trailingIcon = {
            Row {
                TextButton(onClick = { localRevealed = !shown; onRevealedChange?.invoke(!shown) }) { Text(if (shown) "Ukryj" else "Pokaż") }
                TextButton(onClick = onCopy) { Text("Kopiuj") }
            }
        },
    )
}

/** A plain one-line field; with [onCopy] it has a "Kopiuj" button. */
@Composable
fun PlainField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    monospace: Boolean = false,
    placeholder: String? = null,
    onCopy: (() -> Unit)? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        textStyle = fieldTextStyle(monospace),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        trailingIcon = onCopy?.let { copy -> { TextButton(onClick = copy) { Text("Kopiuj") } } },
    )
}

/** A multi-line text field (an entry's note, a note's text). */
@Composable
fun MultilineField(value: String, onValueChange: (String) -> Unit, label: String, minLines: Int = 3) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        minLines = minLines,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun fieldTextStyle(monospace: Boolean) =
    if (monospace) MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge
