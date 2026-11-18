package io.github.sheking94.passholder.app

import android.content.ContentResolver
import android.net.Uri
import io.github.sheking94.passholder.app.ui.FilePicks
import io.github.sheking94.passholder.app.ui.TransferActions
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import io.github.sheking94.passholder.core.transfer.PassHolderZip
import io.github.sheking94.passholder.core.transfer.Transfer
import io.github.sheking94.passholder.core.transfer.TransferFormat
import java.io.IOException

/** "Import i eksport": PassHolder (JSON and ZIP), Bitwarden and NordPass files through the system file picker. */
internal class TransferModel(
    private val ui: UiStateHolder,
    private val store: PhoneVaultStore,
    private val resolver: ContentResolver,
    private val filePicks: FilePicks,
) : TransferActions,
    FilePicks by filePicks {
    /** Set by [confirmExport] and used up by the next export callback, whatever it brings ([takeExportApproval]). */
    @Volatile
    private var exportApproved = false

    /**
     * The format is recognised from the content: a ZIP (first 4 bytes) is read as a PassHolder ZIP, streamed with
     * its files; anything else as text. Entries already in the vault with the same content are skipped.
     */
    override fun importFrom(uri: Uri?) {
        endFilePick()
        // The vault may have locked while the picker was open: the file is not even read then.
        if (uri == null || !store.isUnlocked) return
        ui.launchOperation("Importuję…") {
            val summary = if (TransferFiles.isZip(resolver, uri)) {
                val (parsed, result) = TransferFiles.openArchive(resolver, uri).use { store.importArchive(it) }
                importSummary(parsed, result.entries, TransferFormat.PASSHOLDER, ArchiveFiles(result.filesAdded, result.fileSkips))
            } else {
                val text = TransferFiles.readText(resolver, uri)
                val (format, parsed) = Transfer.parseImportFile(text)
                val result = store.importContents(parsed.entries)
                // A bare passholder.json taken out of an archive: its files are listed as skipped.
                importSummary(parsed, result, format, ArchiveFiles(0, parsed.files))
            }
            ui.showStatus(summary)
            ui.refreshInBackground()
        }
    }

    /** Security review V3-N6: also when the fingerprint unlocks the vault. */
    override fun confirmExport(masterPassword: String, onConfirmed: () -> Unit) {
        if (masterPassword.isEmpty()) return fail(EXPORT_NEEDS_PASSWORD)
        if (ui.busy) return
        exportApproved = false
        ui.launchOperation("Sprawdzam hasło główne…", onSuccess = {
            exportApproved = true
            ui.update { it.copy(status = null) }
            onConfirmed()
        }) { store.confirmMasterPassword(masterPassword) }
    }

    override fun exportTo(format: TransferFormat, uri: Uri?) {
        val target = approvedTarget(uri) ?: return
        ui.launchOperation("Zapisuję plik…") {
            TransferFiles.writeText(resolver, target, Transfer.exportFile(format, store.allContents()))
            ui.showStatus("Zapisano plik. Usuń go zaraz po użyciu, zawiera hasła jawnym tekstem.")
        }
    }

    /**
     * The entries and their decrypted files are streamed into the archive, one file in memory at a time; a file that
     * is not complete on the phone (waiting for sync) or cannot be decrypted is left out and counted.
     */
    override fun exportArchiveTo(uri: Uri?) {
        val target = approvedTarget(uri) ?: return
        ui.launchOperation("Przygotowuję archiwum…") {
            val entries = store.allContents()
            val out = TransferFiles.writeArchive(resolver, target) { stream ->
                PassHolderZip.export(entries, stream, ::readForExport)
            }
            val exported = if (out.files > 0) {
                "Wyeksportowano ${entriesNoun(entries.size)} i ${filesNoun(out.files)}."
            } else {
                "Wyeksportowano ${entriesNoun(entries.size)}."
            }
            val missing = if (out.missing > 0) missingFilesSentence(out.missing) else null
            ui.showStatus(listOfNotNull(exported, missing, "Usuń archiwum, gdy nie będzie już potrzebne.").joinToString(" "))
        }
    }

    /**
     * The common start of both exports: the picker's window ends and the approval is used up, whatever came back.
     * [uri] when there is somewhere to write and the master password was confirmed for it, otherwise null.
     */
    private fun approvedTarget(uri: Uri?): Uri? {
        endFilePick()
        val approved = takeExportApproval()
        if (uri == null || !store.isUnlocked) return null
        if (!approved) {
            fail(EXPORT_NEEDS_PASSWORD)
            return null
        }
        return uri
    }

    private fun takeExportApproval(): Boolean = exportApproved.also { exportApproved = false }

    /**
     * A file's decrypted bytes for the archive, or null when it is not complete or cannot be read (counted as missing).
     * The vault locking ([ErrorCode.VAULT_LOCKED]) is not a missing file: it ends the export.
     */
    private fun readForExport(a: Attachment): ByteArray? = try {
        if (store.isFileComplete(a)) store.readFile(a) else null
    } catch (e: PassHolderException) {
        if (e.code != ErrorCode.FILE_CORRUPTED) throw e
        null
    } catch (_: IOException) {
        null
    }

    private companion object {
        const val EXPORT_NEEDS_PASSWORD = "Wpisz hasło główne, żeby zapisać plik."
    }
}
