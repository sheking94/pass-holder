package io.github.sheking94.passholder.app.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.ManagedActivityResultLauncher
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
import io.github.sheking94.passholder.app.TransferFiles
import io.github.sheking94.passholder.app.UiState
import io.github.sheking94.passholder.app.skippedFilesPhrase
import io.github.sheking94.passholder.core.transfer.TransferFormat
import io.github.sheking94.passholder.core.transfer.countAttachments

/** What an import file may be called by the picker: JSON and CSV come under many names; ZIP for a PassHolder ZIP. */
private val IMPORT_TYPES =
    arrayOf("application/json", "text/*", "text/comma-separated-values", "application/zip", "application/octet-stream")

internal const val CSV_WARNING =
    "Nie otwieraj pliku CSV w Excelu ani LibreOffice: pole zaczynające się od „=”, „+”, „-” lub „@” arkusz wykona jako formułę."

/** One way to export: a [TextFile] in a [TransferFormat], or the PassHolder [Zip] with the files. */
private sealed class ExportChoice(val label: String, val hint: Boolean) {
    class TextFile(val format: TransferFormat, label: String, hint: Boolean) : ExportChoice(label, hint)

    /** Written with the files by [TransferActions.exportArchiveTo]. */
    data object Zip : ExportChoice("PassHolder ZIP (wpisy i pliki)", hint = false)
}

/** The same choices, order and labels as the extension. */
private val EXPORT_CHOICES = listOf(
    ExportChoice.TextFile(TransferFormat.PASSHOLDER, "PassHolder JSON (wszystko, bez strat)", hint = false),
    ExportChoice.Zip,
    ExportChoice.TextFile(TransferFormat.BITWARDEN, "Bitwarden JSON", hint = true),
    ExportChoice.TextFile(TransferFormat.NORDPASS, "NordPass CSV", hint = true),
)

private const val PLAIN_WARNING =
    "Uwaga: plik nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, folder w chmurze), " +
        "pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu."
private const val ZIP_WARNING =
    "Uwaga: archiwum nie jest zaszyfrowane. Zawiera hasła jawnym tekstem i odszyfrowane pliki. Każdy, kto je zobaczy " +
        "(inny program, kopia zapasowa, folder w chmurze), pozna je wszystkie. Usuń je zaraz po użyciu."

/**
 * "Import i eksport": files go through the system file picker (another app, so [TransferActions.beginFilePick]
 * comes first). Export is plain text (a PassHolder ZIP also holds the decrypted files): the button waits for the user
 * to confirm they understand that, and the save dialog opens only after the master password ([TransferActions.confirmExport]).
 */
@Composable
fun TransferScreen(state: UiState, navigation: Navigation, transfer: TransferActions) {
    BackHandler(onBack = navigation::backToList)
    FormColumn {
        Text("Import i eksport", style = MaterialTheme.typography.headlineSmall)
        Text("Import rozpoznaje format sam: PassHolder ZIP, PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.")
        ImportSection(state, transfer)
        HorizontalDivider()
        ExportSection(state, transfer)
        HorizontalDivider()
        OutlinedButton(onClick = navigation::backToList) { Text("Wróć do listy") }
        StatusLine(state.status, state.busy)
    }
}

@Composable
private fun ImportSection(state: UiState, transfer: TransferActions) {
    val openFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { transfer.importFrom(it) }
    Text("Import", style = MaterialTheme.typography.titleMedium)
    Text("Wpisy, które już są w sejfie z identyczną treścią, zostaną pominięte.", style = MaterialTheme.typography.bodyMedium)
    Button(onClick = { transfer.launchPicker { openFile.launch(IMPORT_TYPES) } }, enabled = !state.busy) { Text("Importuj plik") }
}

/** The format, the warning, "Rozumiem…", the master password and "Zapisz plik". */
@Composable
private fun ExportSection(state: UiState, transfer: TransferActions) {
    // An index into EXPORT_CHOICES (rememberSaveable keeps a plain Int).
    var chosen by rememberSaveable { mutableIntStateOf(0) }
    val choice = EXPORT_CHOICES[chosen]
    var understood by rememberSaveable { mutableStateOf(false) }
    // Security review V3-N6. remember, not rememberSaveable: the password must not end up in the saved instance state.
    var password by remember { mutableStateOf("") }
    val save = rememberExportLaunchers(transfer, (choice as? ExportChoice.TextFile)?.format)

    Text("Eksport", style = MaterialTheme.typography.titleMedium)
    ExportChoices(chosen) { chosen = it }
    val files = countAttachments(state.entries.map { it.content })
    if (files > 0) {
        Text(
            "${skippedFilesPhrase(files)} w formatach JSON i CSV. Wybierz PassHolder ZIP, żeby je zabrać.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
    Text(
        if (choice == ExportChoice.Zip) ZIP_WARNING else PLAIN_WARNING,
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
    MasterPasswordField(password, {
        password = it
        transfer.clearError()
    })
    Button(
        onClick = {
            val typed = password
            password = ""
            transfer.confirmExport(typed) { transfer.launchPicker { save.launch(choice) } }
        },
        enabled = understood && !state.busy,
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.error,
            contentColor = MaterialTheme.colorScheme.onError,
        ),
    ) { Text("Zapisz plik") }
}

/** The radio buttons of [EXPORT_CHOICES], with the hints under the formats that lose fields. */
@Composable
private fun ExportChoices(chosen: Int, onChoose: (Int) -> Unit) {
    Column(Modifier.selectableGroup()) {
        EXPORT_CHOICES.forEachIndexed { i, option ->
            Row(
                Modifier.fillMaxWidth().selectable(selected = chosen == i, role = Role.RadioButton) { onChoose(i) },
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
            if (option is ExportChoice.TextFile && option.format == TransferFormat.NORDPASS) {
                Text(CSV_WARNING, Modifier.padding(start = 32.dp, bottom = 4.dp), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** The save dialogs: their file type is fixed per launcher, so JSON, CSV and ZIP have one each. */
private class ExportLaunchers(
    private val json: ManagedActivityResultLauncher<String, Uri?>,
    private val csv: ManagedActivityResultLauncher<String, Uri?>,
    private val zip: ManagedActivityResultLauncher<String, Uri?>,
) {
    /** Opens the save dialog of [choice] with the name it suggests. */
    fun launch(choice: ExportChoice) = when (choice) {
        ExportChoice.Zip -> zip.launch(TransferFiles.archiveFileName())

        is ExportChoice.TextFile -> {
            val launcher = if (choice.format == TransferFormat.NORDPASS) csv else json
            launcher.launch(TransferFiles.defaultFileName(choice.format))
        }
    }
}

/** [textFormat] is the chosen text format when the dialog returns (null while the ZIP is chosen). */
@Composable
private fun rememberExportLaunchers(transfer: TransferActions, textFormat: TransferFormat?): ExportLaunchers {
    val json = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        transfer.exportTo(textFormat ?: TransferFormat.PASSHOLDER, uri)
    }
    val csv =
        rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) {
            transfer.exportTo(TransferFormat.NORDPASS, it)
        }
    val zip = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { transfer.exportArchiveTo(it) }
    return remember(json, csv, zip) { ExportLaunchers(json, csv, zip) }
}
