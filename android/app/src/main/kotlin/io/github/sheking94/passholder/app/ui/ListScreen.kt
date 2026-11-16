package io.github.sheking94.passholder.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.entrySummary
import io.github.sheking94.passholder.app.entries.matchesQuery
import io.github.sheking94.passholder.core.p2p.LoginFields

@Composable
fun ListScreen(state: UiState, vm: AppViewModel) {
    // The phrase belongs to the tab: changing tabs starts a fresh search.
    var query by rememberSaveable(state.tab) { mutableStateOf("") }
    val rows = state.entries.filter { EntryType.of(it.content.fields) == state.tab }
        .filter { query.isBlank() || matchesQuery(it.content, query) }

    Scaffold(
        topBar = { VaultTopBar(state, vm) },
        bottomBar = {
            // PassHolderUi already keeps every screen out of the system bars.
            NavigationBar(windowInsets = WindowInsets(0)) {
                EntryType.entries.forEach { type ->
                    NavigationBarItem(
                        selected = type == state.tab,
                        onClick = { vm.selectTab(type) },
                        icon = { Text(type.icon) },
                        label = { Text(type.tab, maxLines = 1) },
                    )
                }
            }
        },
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(query, {
                    query = it
                }, placeholder = { Text("Szukaj…") }, singleLine = true, modifier = Modifier.weight(1f))
                Button(onClick = { vm.newEntry(state.tab) }, enabled = !state.busy) { Text("+ Dodaj") }
            }
            if (state.unreadable > 0) {
                Text(
                    "Wpisów nie do odczytania: ${state.unreadable}. Zaszyfrował je inny klucz, np. wtyczka sparowana z innym sejfem.",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            LazyColumn(Modifier.weight(1f)) {
                if (rows.isEmpty()) {
                    item {
                        Text(if (query.isBlank()) "Brak wpisów. Dodaj pierwszy." else "Nic nie pasuje.", Modifier.padding(vertical = 16.dp))
                    }
                }
                items(rows, key = { it.id }) { entry ->
                    val login = entry.content.fields as? LoginFields
                    Row(
                        Modifier.clickable(enabled = !state.busy) { vm.openEntry(entry.id) }.padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(state.tab.icon, style = MaterialTheme.typography.titleLarge)
                        Column(Modifier.weight(1f)) {
                            val files = entry.content.attachments.size
                            Text(
                                if (files > 0) "${entry.content.name} 📎 $files" else entry.content.name,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                entrySummary(entry.content),
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (login != null) {
                            TextButton(onClick = { vm.copy("login", login.username, false) }) { Text("Login") }
                            TextButton(onClick = { vm.copy("hasło", login.password, true) }) { Text("Hasło") }
                        }
                    }
                    HorizontalDivider()
                }
            }
            StatusLine(state.status, state.busy)
        }
    }
}
