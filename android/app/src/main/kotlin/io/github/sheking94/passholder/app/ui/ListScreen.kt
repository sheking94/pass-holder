package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.UiState

@Composable
fun ListScreen(state: UiState, vm: AppViewModel) {
    var query by rememberSaveable { mutableStateOf("") }
    val rows = state.entries.filter {
        val c = it.credentials!!
        query.isBlank() || "${c.name} ${c.username}".contains(query.trim(), ignoreCase = true)
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(query, { query = it }, placeholder = { Text("Szukaj…") }, singleLine = true, modifier = Modifier.weight(1f))
            Button(onClick = { vm.openEntry(null) }, enabled = !state.busy) { Text("+ Dodaj") }
        }
        LazyColumn(Modifier.weight(1f)) {
            if (rows.isEmpty()) {
                item { Text(if (query.isBlank()) "Brak wpisów. Dodaj pierwszy." else "Nic nie pasuje.", Modifier.padding(vertical = 16.dp)) }
            }
            items(rows, key = { it.id }) { entry ->
                val c = entry.credentials!!
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = !state.busy) { vm.openEntry(entry.id) }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(c.name + if (entry.dirty) " •" else "", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(c.username, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(onClick = { vm.copy(c.username, "login", sensitive = false) }) { Text("Login") }
                    TextButton(onClick = { vm.copy(c.password, "hasło", sensitive = true) }) { Text("Hasło") }
                }
                HorizontalDivider()
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = vm::sync, enabled = !state.busy) { Text("Synchronizuj") }
            OutlinedButton(onClick = vm::lock, enabled = !state.busy) { Text("Zablokuj") }
        }
        StatusLine(state.status, state.busy)
    }
}
