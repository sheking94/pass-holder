package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState

private const val MIN_MASTER_PASSWORD = 12

/**
 * Pairing in two steps:
 * 1. address → the app reads the server certificate and shows its SHA-256 fingerprint;
 * 2. after you confirm it matches the Pi, master password (and the setup token for a new vault).
 */
@Composable
fun ConnectScreen(state: UiState, vm: AppViewModel) {
    var isNew by rememberSaveable { mutableStateOf(false) }
    var url by rememberSaveable { mutableStateOf("https://") }
    var token by rememberSaveable { mutableStateOf("") }
    // remember, not rememberSaveable: the master password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var confirmed by rememberSaveable { mutableStateOf(false) }
    val pairing = state.pairing

    FormColumn {
        Text("PassHolder: połącz z serwerem", style = MaterialTheme.typography.headlineSmall)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(false to "Mam już sejf", true to "Nowy sejf").forEachIndexed { i, (value, label) ->
                SegmentedButton(selected = isNew == value, onClick = { isNew = value }, shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
            }
        }

        if (pairing == null) {
            PlainField(url, { url = it }, "Adres serwera, np. https://passholder.local:8443", KeyboardType.Uri)
            Button(onClick = { confirmed = false; vm.inspectServer(url) }, enabled = !state.busy) { Text("Dalej: sprawdź certyfikat") }
        } else {
            Text("Serwer: ${pairing.url}", style = MaterialTheme.typography.bodyMedium)
            if (pairing.fingerprint != null) {
                Card {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Odcisk SHA-256 certyfikatu serwera:", style = MaterialTheme.typography.labelLarge)
                        // 32 bytes as 4 lines of 8, easy to compare by eye.
                        Text(
                            pairing.fingerprint.split(":").chunked(8).joinToString("\n") { it.joinToString(":") },
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text(
                            "Porównaj z wynikiem na Raspberry Pi:\nsudo openssl x509 -in /etc/passholder/tls/server.crt -noout -fingerprint -sha256",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(confirmed, { confirmed = it })
                            Text("Odcisk się zgadza")
                        }
                    }
                }
            }
            if (isNew) PlainField(token, { token = it }, "Token z logu serwera (jednorazowy)", monospace = true)
            PasswordField(password, { password = it }, "Hasło główne")
            if (isNew) PasswordField(repeat, { repeat = it }, "Powtórz hasło główne")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled = !state.busy && (confirmed || pairing.fingerprint == null),
                    onClick = {
                        when {
                            isNew && password.length < MIN_MASTER_PASSWORD -> vm.fail("Hasło główne musi mieć co najmniej $MIN_MASTER_PASSWORD znaków")
                            isNew && password != repeat -> vm.fail("Hasła się różnią")
                            else -> vm.connect(isNew, token, password)
                        }
                    },
                ) { Text(if (isNew) "Załóż sejf" else "Połącz") }
                OutlinedButton(onClick = vm::cancelPairing, enabled = !state.busy) { Text("Wstecz") }
            }
        }
        StatusLine(state.status, state.busy)
    }
}
