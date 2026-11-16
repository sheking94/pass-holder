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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.TransferFiles
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.app.skippedFilesPhrase
import io.github.sheking94.passholder.core.transfer.TransferFormat
import io.github.sheking94.passholder.core.transfer.countAttachments

/** What an import file may be called by the picker: JSON and CSV come under many names; ZIP for a PassHolder ZIP. */
private val IMPORT_TYPES =
    arrayOf("application/json", "text/*", "text/comma-separated-values", "application/zip", "application/octet-stream")

/** [zip]: PassHolder ZIP, written with the files by [AppViewModel.exportArchiveTo] ([format] is then not used). */
internal const val CSV_WARNING =
    "Nie otwieraj pliku CSV w Excelu ani LibreOffice: pole zaczynające się od „=”, „+”, „-” lub „@” arkusz wykona jako formułę."

private class ExportChoice(val format: TransferFormat, val label: String, val hint: Boolean, val zip: Boolean = false)

/** The same choices, order and labels as the extension. */
private val EXPORT_CHOICES = listOf(
    ExportChoice(TransferFormat.PASSHOLDER, "PassHolder JSON (wszystko, bez strat)", hint = false),
    ExportChoice(TransferFormat.PASSHOLDER, "PassHolder ZIP (wpisy i pliki)", hint = false, zip = true),
    ExportChoice(TransferFormat.BITWARDEN, "Bitwarden JSON", hint = true),
    ExportChoice(TransferFormat.NORDPASS, "NordPass CSV", hint = true),
)

private const val PLAIN_WARNING =
    "Uwaga: plik nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, folder w chmurze), " +
        "pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu."
private const val ZIP_WARNING =
    "Uwaga: archiwum nie jest zaszyfrowane. Zawiera hasła jawnym tekstem i odszyfrowane pliki. Każdy, kto je zobaczy " +
        "(inny program, kopia zapasowa, folder w chmurze), pozna je wszystkie. Usuń je zaraz po użyciu."

/**
 * "Import i eksport": files go through the system file picker (another app, so [AppViewModel.beginFilePick]
 * comes first). Export is plain text (a PassHolder ZIP also holds the decrypted files): the button waits for the user
 * to confirm they understand that, and the save dialog opens only after the master password ([AppViewModel.confirmExport]).
 */
@Composable
fun TransferScreen(state: UiState, vm: AppViewModel) {
    BackHandler(onBack = vm::backToList)
    // An index into EXPORT_CHOICES: two choices share TransferFormat.PASSHOLDER.
    var chosen by rememberSaveable { mutableIntStateOf(0) }
    val choice = EXPORT_CHOICES[chosen]
    val format = choice.format
    var understood by rememberSaveable { mutableStateOf(false) }
    // Security review V3-N6. remember, not rememberSaveable: the password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }

    val openFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { vm.importFrom(it) }
    // The save dialog's type is fixed per launcher.
    val saveJson = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { vm.exportTo(format, it) }
    val saveCsv = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { vm.exportTo(format, it) }
    val saveZip = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { vm.exportArchiveTo(it) }

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
        Text("Import rozpoznaje format sam: PassHolder ZIP, PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.")

        Text("Import", style = MaterialTheme.typography.titleMedium)
        Text("Wpisy, które już są w sejfie z identyczną treścią, zostaną pominięte.", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = { pick { openFile.launch(IMPORT_TYPES) } }, enabled = !state.busy) { Text("Importuj plik") }

        HorizontalDivider()
        Text("Eksport", style = MaterialTheme.typography.titleMedium)
        Column(Modifier.selectableGroup()) {
            EXPORT_CHOICES.forEachIndexed { i, option ->
                Row(
                    Modifier.fillMaxWidth().selectable(selected = chosen == i, role = Role.RadioButton) { chosen = i },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = chosen == i, onClick = null)
                    Text(option.label, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyLarge)
                }
                if (option.hint) {
                    Text(
                        "Część pól trafi do notatki lub własnych pól.",
                        Modifier.padding(start = 32.dp, bottom = 4.dp),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                // Security review N2: the values stay as they are (import must restore them exactly), so warn instead.
                if (option.format == TransferFormat.NORDPASS) {
                    Text(CSV_WARNING, Modifier.padding(start = 32.dp, bottom = 4.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        val files = countAttachments(state.entries.map { it.content })
        if (files > 0) {
            Text(
                "${skippedFilesPhrase(files)} w formatach JSON i CSV. Wybierz PassHolder ZIP, żeby je zabrać.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text(
            if (choice.zip) ZIP_WARNING else PLAIN_WARNING,
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
        PasswordField(password, {
            password = it
            vm.clearError()
        }, "Hasło główne")
        Button(
            onClick = {
                val name = TransferFiles.defaultFileName(format, zip = choice.zip)
                val typed = password
                password = ""
                vm.confirmExport(typed) {
                    pick {
                        when {
                            choice.zip -> saveZip.launch(name)
                            format == TransferFormat.NORDPASS -> saveCsv.launch(name)
                            else -> saveJson.launch(name)
                        }
                    }
                }
            },
            enabled = understood && !state.busy,
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
            ),
        ) { Text("Zapisz plik") }

        HorizontalDivider()
        OutlinedButton(onClick = vm::backToList) { Text("Wróć do listy") }
        StatusLine(state.status, state.busy)
    }
}
