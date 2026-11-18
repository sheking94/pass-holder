package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.transfer.ArchiveImportResult
import io.github.sheking94.passholder.core.transfer.ArchiveReader
import io.github.sheking94.passholder.core.transfer.ArchivedFile
import io.github.sheking94.passholder.core.transfer.ImportSkip
import io.github.sheking94.passholder.core.transfer.ImportedArchive
import io.github.sheking94.passholder.core.transfer.ParsedArchive
import io.github.sheking94.passholder.core.transfer.contentKey
import java.io.InputStream

/** Imports a PassHolder ZIP into the phone's vault; see [PhoneVaultStore.importArchive]. */
internal class PhoneArchiveImport(
    private val vaultLock: Any,
    private val entries: PhoneEntries,
    private val files: PhoneFiles,
    private val onError: (Throwable) -> Unit,
) {
    /** An archive read for [import]: the entries to import, with the files that could be stored. */
    private class PreparedArchive(val parsed: ParsedArchive, val contents: List<EntryContent>, val fileSkips: List<ImportSkip>)

    /** Files of an archive stored with [PhoneFiles.add], by archive path, and why the others were not. */
    private class StoredFiles(val attachments: Map<String, Attachment>, val reasons: Map<String, String>)

    fun import(input: InputStream): ImportedArchive {
        val added = ArrayList<String>()
        try {
            val prepared = ArchiveReader(input).use { reader -> prepare(reader, added) }
            return synchronized(vaultLock) {
                val result = entries.import(prepared.contents)
                // Entries are written now: from here on a failure must not delete files they may use.
                val mine = added.toList()
                added.clear()
                val used = files.usedIds()
                val filesAdded = mine.count { it in used }
                try {
                    files.discard(mine)
                } catch (e: Exception) {
                    // Left for pruneFiles, which deletes unused files after a day.
                    reportError(onError, e)
                }
                ImportedArchive(prepared.parsed, ArchiveImportResult(result, filesAdded, prepared.fileSkips))
            }
        } catch (e: Throwable) {
            files.dropNew(added)
            throw e
        }
    }

    /** The index, then the files of the entries not already in the vault, stored (their ids go to [added] at once). */
    private fun prepare(reader: ArchiveReader, added: MutableList<String>): PreparedArchive {
        val parsed = reader.readIndex()
        // Only against the vault: importContents drops repeats within the archive itself, and it may refuse the first
        // copy as too large, so a later copy must still bring its files (unused ones are discarded).
        val known = entries.allContents().mapTo(HashSet(), ::contentKey)
        val fresh = parsed.entries.filter { contentKey(it.content) !in known }
        val stored = storeFiles(reader, fresh.flatMap { it.files }, added)
        val freshPositions = fresh.mapTo(HashSet()) { it.position }
        val skips = ArrayList<ImportSkip>()
        val contents = parsed.entries.map { e ->
            if (e.position !in freshPositions) return@map e.content
            val kept = e.files.mapNotNull { f ->
                val attachment = stored.attachments[f.path]
                if (attachment == null) {
                    skips.add(ImportSkip("wpis ${e.position}, ${f.name}", stored.reasons[f.path] ?: "brak w archiwum"))
                }
                attachment
            }
            e.content.copy(attachments = kept)
        }
        return PreparedArchive(parsed, contents, skips)
    }

    /** Reads the [wanted] files from the rest of the archive and stores each one of the described size. */
    private fun storeFiles(reader: ArchiveReader, wanted: List<ArchivedFile>, added: MutableList<String>): StoredFiles {
        val byPath = wanted.associateBy { it.path }
        val attachments = HashMap<String, Attachment>()
        val reasons = HashMap<String, String>()
        reader.forEachFile(byPath.keys, { path, reason -> reasons[path] = reason }) { path, bytes ->
            val f = byPath.getValue(path)
            if (bytes.size != f.size) {
                reasons[path] = "inny rozmiar niż w opisie"
            } else {
                val attachment = files.add(bytes, f.name, f.mime)
                added.add(attachment.id)
                attachments[path] = attachment
            }
        }
        return StoredFiles(attachments, reasons)
    }
}
