package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.BackHandler
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState

/**
 * Changes the addresses of the already paired server, e.g. adds the Tailscale address to a phone paired
 * at home. The certificate pin stays as it is, so there is no fingerprint to confirm again: an address
 * only works if the server behind it presents the certificate confirmed when pairing.
 */
@Composable
fun AddressesScreen(state: UiState, vm: AppViewModel) {
    val current = remember { vm.serverUrls() }
    var url by rememberSaveable { mutableStateOf(current.getOrElse(0) { "" }) }
    var secondUrl by rememberSaveable { mutableStateOf(current.getOrElse(1) { "" }) }
    BackHandler(onBack = vm::backToList)

    FormColumn {
        Text("Adresy serwera", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Podaj adresy, pod którymi łączysz się z tym samym serwerem, np. w sieci domowej i w Tailscale. " +
                "Przy synchronizacji telefon sam wybierze ten, który odpowiada.",
            style = MaterialTheme.typography.bodyMedium,
        )
        PlainField(url, { url = it }, URL_LABEL, KeyboardType.Uri)
        PlainField(secondUrl, { secondUrl = it }, SECOND_URL_LABEL, KeyboardType.Uri)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.saveServerUrls(listOf(url, secondUrl)) }, enabled = !state.busy) { Text("Zapisz") }
            OutlinedButton(onClick = vm::backToList, enabled = !state.busy) { Text("Wstecz") }
        }
        StatusLine(state.status, state.busy)
    }
}
