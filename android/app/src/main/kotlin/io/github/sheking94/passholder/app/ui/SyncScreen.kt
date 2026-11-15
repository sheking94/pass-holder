package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.SyncUiState
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.core.p2p.PairingOffer
import kotlinx.coroutines.delay

/** "Synchronizacja": the phone waits for the extension on the addresses shown; "Dodaj wtyczkę" gives a pairing code. */
@Composable
fun SyncScreen(state: UiState, vm: AppViewModel) {
    val sync by vm.syncState.collectAsStateWithLifecycle()
    BackHandler(onBack = vm::closeSync)

    FormColumn {
        Text("Synchronizacja", style = MaterialTheme.typography.headlineSmall)
        if (sync.running) {
            Text("Czekam na wtyczkę…", style = MaterialTheme.typography.titleMedium)
            Addresses(sync)
            PairingCode(sync, vm, newCodeHint = "Kod wygasł lub został użyty. Dodaj wtyczkę ponownie, aby dostać nowy kod.")
            Button(onClick = vm::addExtension, enabled = !state.busy) { Text("Dodaj wtyczkę") }
            Text(
                "Ekran nie zgaśnie, dopóki działa tryb synchronizacji. Wyłączy się sam po 5 min bez synchronizacji i po wyjściu z aplikacji. Działa tylko w Wi-Fi i Tailscale.",
                style = MaterialTheme.typography.bodySmall,
            )
        } else {
            sync.stoppedReason?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            OutlinedButton(onClick = vm::startSync, enabled = !state.busy) { Text("Włącz ponownie") }
        }
        sync.lastEvent?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold) }
        Button(onClick = vm::closeSync) { Text("Zakończ") }
        StatusLine(state.status, state.busy)
    }
}

/** The phone's addresses, in monospace: the user types one of them into the extension. */
@Composable
fun Addresses(sync: SyncUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (sync.addresses.isEmpty()) {
            Text(
                "Telefon nie ma adresu w sieci. Połącz go z tą samą siecią Wi-Fi co komputer.",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            Text("Adres telefonu do wpisania we wtyczce:", style = MaterialTheme.typography.bodyMedium)
            SelectionContainer {
                Column {
                    sync.addresses.forEach { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyLarge) }
                }
            }
        }
    }
}

/** The code on screen in large digits ("1234 5678") with a mm:ss countdown, or [newCodeHint] once it is gone. */
@Composable
fun PairingCode(sync: SyncUiState, vm: AppViewModel, newCodeHint: String) {
    val offer = sync.offer
    if (offer != null) {
        var remaining by remember(offer.sid) { mutableLongStateOf(vm.pairingCodeRemainingMs(offer)) }
        LaunchedEffect(offer.sid) {
            while (true) {
                remaining = vm.pairingCodeRemainingMs(offer)
                delay(1_000)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Kod parowania (wpisz go we wtyczce):", style = MaterialTheme.typography.bodyMedium)
            Text(formatCode(offer), fontFamily = FontFamily.Monospace, fontSize = 40.sp, fontWeight = FontWeight.Bold)
            Text("Ważny jeszcze ${formatRemaining(remaining)}", style = MaterialTheme.typography.bodyMedium)
        }
    } else if (sync.offerSpent) {
        Text(newCodeHint, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
    }
}

private fun formatCode(offer: PairingOffer) = offer.code.chunked(4).joinToString(" ")

private fun formatRemaining(ms: Long): String {
    val seconds = (ms + 999) / 1000
    return "%02d:%02d".format(seconds / 60, seconds % 60)
}
