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
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.entrySummary
import io.github.sheking94.passholder.app.entries.matchesQuery
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.PhoneEntry

@Composable
fun ListScreen(state: UiState, navigation: Navigation, vault: VaultActions, entries: EntryActions) {
    // The phrase belongs to the tab: changing tabs starts a fresh search.
    var query by rememberSaveable(state.tab) { mutableStateOf("") }
    val rows = state.entries.filter { EntryType.of(it.content.fields) == state.tab }
        .filter { query.isBlank() || matchesQuery(it.content, query) }

    Scaffold(
        topBar = { VaultTopBar(state, navigation, vault) },
        bottomBar = { TypeTabs(state.tab, navigation::selectTab) },
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(query, {
                    query = it
                }, placeholder = { Text("Szukaj…") }, singleLine = true, modifier = Modifier.weight(1f))
                Button(onClick = { navigation.newEntry(state.tab) }, enabled = !state.busy) { Text("+ Dodaj") }
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
                    EntryRow(entry, state.tab, state.busy, onOpen = { navigation.openEntry(entry.id) }, entries)
                    HorizontalDivider()
                }
            }
            StatusLine(state.status, state.busy)
        }
    }
}

/** The tabs of the entry types at the bottom. */
@Composable
private fun TypeTabs(selected: EntryType, onSelect: (EntryType) -> Unit) {
    // PassHolderUi already keeps every screen out of the system bars.
    NavigationBar(windowInsets = WindowInsets(0)) {
        EntryType.entries.forEach { type ->
            NavigationBarItem(
                selected = type == selected,
                onClick = { onSelect(type) },
                icon = { Text(type.icon) },
                label = { Text(type.tab, maxLines = 1) },
            )
        }
    }
}

/** An entry: its icon, name (with the number of files), summary and, for a login, "Login" and "Hasło" to copy. */
@Composable
private fun EntryRow(entry: PhoneEntry, type: EntryType, busy: Boolean, onOpen: () -> Unit, entries: EntryActions) {
    val login = entry.content.fields as? LoginFields
    Row(
        Modifier.clickable(enabled = !busy, onClick = onOpen).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(type.icon, style = MaterialTheme.typography.titleLarge)
        Column(Modifier.weight(1f)) {
            val files = entry.content.attachments.size
            Text(
                if (files > 0) "${entry.content.name} 📎 $files" else entry.content.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(entrySummary(entry.content), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (login != null) {
            TextButton(onClick = { entries.copyText("login", login.username) }) { Text("Login") }
            TextButton(onClick = { entries.copySecret("hasło", login.password) }) { Text("Hasło") }
        }
    }
}
