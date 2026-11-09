package io.github.sheking94.passholder.app.ui

import android.content.ActivityNotFoundException
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.TransferFiles
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.core.transfer.TransferFormat

/** What an import file may be called by the picker: JSON and CSV come under many names. */
private val IMPORT_TYPES = arrayOf("application/json", "text/*", "text/comma-separated-values", "application/octet-stream")

private class ExportChoice(val format: TransferFormat, val label: String, val hint: Boolean)

/** The same choices and labels as the extension. */
private val EXPORT_CHOICES = listOf(
    ExportChoice(TransferFormat.PASSHOLDER, "PassHolder JSON (wszystko, bez strat)", hint = false),
    ExportChoice(TransferFormat.BITWARDEN, "Bitwarden JSON", hint = true),
    ExportChoice(TransferFormat.NORDPASS, "NordPass CSV", hint = true),
)

/**
 * "Import i eksport": files go through the system file picker (another app, so [AppViewModel.beginFilePick]
 * comes first). Export is plain text: the button waits for the user to confirm they understand that.
 */
@Composable
fun TransferScreen(state: UiState, vm: AppViewModel) {
    BackHandler(onBack = vm::backToList)
    var format by rememberSaveable { mutableStateOf(TransferFormat.PASSHOLDER) }
    var understood by rememberSaveable { mutableStateOf(false) }

    val openFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { vm.importFrom(it) }
    // The save dialog's type is fixed per launcher.
    val saveJson = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { vm.exportTo(format, it) }
    val saveCsv = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { vm.exportTo(format, it) }

    fun pick(launch: () -> Unit) {
        vm.beginFilePick()
        try {
            launch()
        } catch (_: ActivityNotFoundException) {
            vm.endFilePick()
            vm.fail("Na telefonie nie ma aplikacji do wyboru plików.")
        }
    }

    FormColumn {
        Text("Import i eksport", style = MaterialTheme.typography.headlineSmall)
        Text("Import rozpoznaje format sam: PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.")

        Text("Import", style = MaterialTheme.typography.titleMedium)
        Text("Wpisy, które już są w sejfie z identyczną treścią, zostaną pominięte.", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = { pick { openFile.launch(IMPORT_TYPES) } }, enabled = !state.busy) { Text("Importuj plik") }

        HorizontalDivider()
        Text("Eksport", style = MaterialTheme.typography.titleMedium)
        Column(Modifier.selectableGroup()) {
            EXPORT_CHOICES.forEach { choice ->
                Row(
                    Modifier.fillMaxWidth().selectable(selected = format == choice.format, role = Role.RadioButton) { format = choice.format },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = format == choice.format, onClick = null)
                    Text(choice.label, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyLarge)
                }
                if (choice.hint) {
                    Text(
                        "Część pól trafi do notatki lub własnych pól.",
                        Modifier.padding(start = 32.dp, bottom = 4.dp),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
        Text(
            "Uwaga: plik nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, folder w chmurze), " +
                "pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu.",
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(
            Modifier.fillMaxWidth().toggleable(understood, role = Role.Checkbox) { understood = it },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Checkbox(checked = understood, onCheckedChange = null)
            Text("Rozumiem, plik będzie zawierał hasła jawnym tekstem")
        }
        Button(
            onClick = {
                val name = TransferFiles.defaultFileName(format)
                pick { if (format == TransferFormat.NORDPASS) saveCsv.launch(name) else saveJson.launch(name) }
            },
            enabled = understood && !state.busy,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
        ) { Text("Zapisz plik") }

        HorizontalDivider()
        OutlinedButton(onClick = vm::backToList) { Text("Wróć do listy") }
        StatusLine(state.status, state.busy)
    }
}
