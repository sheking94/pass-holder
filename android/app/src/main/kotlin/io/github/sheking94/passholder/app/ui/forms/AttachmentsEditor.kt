package io.github.sheking94.passholder.app.ui.forms

import android.content.ActivityNotFoundException
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.AttachmentFiles
import io.github.sheking94.passholder.app.CreateDocumentOf
import io.github.sheking94.passholder.app.formatSize
import io.github.sheking94.passholder.core.files.Attachment

/**
 * "Załączniki": a row per file (name, "size · note", "Pobierz", "Usuń") and "+ Dodaj plik". A file added in this
 * form is already encrypted on the phone but belongs to no entry until "Zapisz" ("nowy – zapisz wpis"); one that
 * is not complete on the phone yet waits for the sync. Both cannot be downloaded.
 */
@Composable
fun AttachmentsEditor(attachments: List<Attachment>, onChange: (List<Attachment>) -> Unit, vm: AppViewModel, busy: Boolean) {
    // Ids added in this form: the form's own copy, the ViewModel keeps its own to discard them.
    var added by remember { mutableStateOf(emptySet<String>()) }
    // Null until the first check is done: no note and no download then.
    var ready by remember { mutableStateOf<Set<String>?>(null) }
    var asking by remember { mutableStateOf<Attachment?>(null) }
    // The id only (not secret): a result that comes after the activity was recreated still finds its file.
    var savingId by rememberSaveable { mutableStateOf<String?>(null) }
    val current by rememberUpdatedState(attachments)

    LaunchedEffect(attachments) { ready = vm.fileReady(attachments) }

    val openFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        vm.attachFile(uri, current.size) { a ->
            added = added + a.id
            onChange(current + a)
        }
    }
    val saveFile = rememberLauncherForActivityResult(CreateDocumentOf()) { uri ->
        val target = current.firstOrNull { it.id == savingId }
        savingId = null
        if (target == null) vm.endFilePick() else vm.downloadFile(target, uri)
    }

    fun pick(launch: () -> Unit) {
        vm.beginFilePick()
        try {
            launch()
        } catch (_: ActivityNotFoundException) {
            savingId = null
            vm.endFilePick()
            vm.fail("Na telefonie nie ma aplikacji do wyboru plików.")
        }
    }

    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Załączniki", style = MaterialTheme.typography.titleSmall)
            attachments.forEach { a ->
                key(a.id) {
                    val note = when {
                        a.id in added -> AttachmentFiles.NEW
                        ready?.contains(a.id) == false -> AttachmentFiles.WAITING
                        else -> null
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(a.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                listOfNotNull(formatSize(a.size), note).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        TextButton(onClick = { asking = a }, enabled = ready != null && note == null && !busy) { Text("Pobierz") }
                        TextButton(onClick = { onChange(attachments.filter { it.id != a.id }) }, enabled = !busy) {
                            Text("Usuń", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
            TextButton(onClick = { pick { openFile.launch(arrayOf("*/*")) } }, enabled = !busy) { Text("+ Dodaj plik") }
        }
    }

    asking?.let { a ->
        AlertDialog(
            onDismissRequest = { asking = null },
            title = { Text("Pobrać plik?") },
            text = { Text(AttachmentFiles.DOWNLOAD_WARNING) },
            confirmButton = {
                TextButton(onClick = {
                    asking = null
                    savingId = a.id
                    pick { saveFile.launch(CreateDocumentOf.Input(a.name, a.mime)) }
                }) { Text("Pobierz") }
            },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Anuluj") } },
        )
    }
}
