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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.Status
import io.github.sheking94.passholder.app.UiTexts

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
 * A secret: the master password, an entry's password, TOTP, card number or hidden custom field. Masked, with
 * "Pokaż/Ukryj", and "Kopiuj" when [onCopy] is given. The keyboard stays in [keyboardType] (Password by default)
 * also when shown, so it does not learn or suggest the value. [onDone] makes the keyboard's action "Done" (submit).
 * Pass [revealed] and [onRevealedChange] to show it from outside (a generated password) or to mask it again.
 */
@Composable
fun SecretField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    onCopy: (() -> Unit)? = null,
    onDone: (() -> Unit)? = null,
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
        keyboardOptions = KeyboardOptions(
            keyboardType = keyboardType,
            autoCorrectEnabled = false,
            imeAction = if (onDone != null) ImeAction.Done else ImeAction.Next,
        ),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        trailingIcon = {
            Row {
                TextButton(onClick = {
                    localRevealed = !shown
                    onRevealedChange?.invoke(!shown)
                }) { Text(if (shown) "Ukryj" else "Pokaż") }
                onCopy?.let { copy -> TextButton(onClick = copy) { Text("Kopiuj") } }
            }
        },
    )
}

/** The master password: a [SecretField] labelled "Hasło główne" unless [label] says otherwise. */
@Composable
fun MasterPasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String = UiTexts.MASTER_PASSWORD,
    onDone: (() -> Unit)? = null,
) {
    SecretField(value, onValueChange, label, onDone = onDone)
}

/**
 * A setting that is on or off: [label], an optional [hint] below and a switch. The whole row is the switch, so
 * tapping the label works too.
 */
@Composable
fun SettingSwitchRow(label: String, checked: Boolean, enabled: Boolean, onCheckedChange: (Boolean) -> Unit, hint: String? = null) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
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
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
    )
}

@Composable
private fun fieldTextStyle(monospace: Boolean) =
    if (monospace) MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge
