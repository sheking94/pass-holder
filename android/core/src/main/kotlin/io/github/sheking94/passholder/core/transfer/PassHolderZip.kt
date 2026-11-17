package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.MIB
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.Attachments
import io.github.sheking94.passholder.core.p2p.EntryCodec
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.ImportResult
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.FilterOutputStream
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** What [PassHolderZip.export] wrote: [files] files in the archive, [missing] left out (waiting for sync, damaged). */
data class ExportedArchive(val files: Int, val missing: Int)

/** What an archive import did: the entries as [ImportResult], the files stored with them and the files left out. */
data class ArchiveImportResult(val entries: ImportResult, val filesAdded: Int, val fileSkips: List<ImportSkip>)

/** An imported archive: its [parsed] index (for the entries it skipped) and what the import did. */
data class ImportedArchive(val parsed: ParsedArchive, val result: ArchiveImportResult)

/**
 * PassHolder ZIP: passholder.json (a PassHolder JSON v3 index whose entries describe their files) followed by the
 * decrypted files under files/<n>-<name>; port of core/src/transfer/passholder-zip.ts. Paths from an archive are only
 * used to look entries up in the ZIP, never as file system paths.
 */
object PassHolderZip {
    const val MAX_ZIP_BYTES = 256L * MIB
    const val ARCHIVE_INDEX = "passholder.json"

    /** Largest passholder.json accepted, after inflating. */
    internal const val MAX_INDEX_BYTES = 10 * MIB

    /** Most entries a readable archive may hold. */
    internal const val MAX_ZIP_ENTRIES = 5000

    private val UNSAFE = Regex("[<>:\"|?*]")

    /** Path of the n-th exported file (from 1); characters Windows refuses in file names become "_". */
    fun archivePath(n: Int, name: String): String = "files/$n-${name.replace(UNSAFE, "_")}"

    /** The index of a PassHolder ZIP; see [PassHolderJson.parseArchiveIndex]. */
    fun parseIndex(text: String): ParsedArchive = PassHolderJson.parseArchiveIndex(text)

    /**
     * Writes the entries (sorted as in the JSON export) and their files to [out], which stays open. [readFile] gives
     * a file's decrypted bytes, or null when the file is not available (waiting for sync, damaged): it is then left
     * out and counted in `missing`. The index goes first, so each file is read twice (once to learn whether it can
     * be read, once to write it) and only one file is in memory at a time; every array [readFile] returns is zeroed.
     */
    fun export(entries: List<EntryContent>, out: OutputStream, readFile: (Attachment) -> ByteArray?): ExportedArchive =
        export(entries, out, readFile, System.currentTimeMillis())

    /** A file the export will write: [size] read in the first pass, [path] its place in the archive. */
    private class Planned(val attachment: Attachment, val path: String, val size: Int)

    /** An entry with the files of it that could be read in the first pass. */
    private class PlannedEntry(val content: EntryContent, val files: List<Planned>)

    /** The export plan and how many files could not be read for it. */
    private class Plan(val entries: List<PlannedEntry>, val missing: Int)

    internal fun export(
        entries: List<EntryContent>,
        out: OutputStream,
        readFile: (Attachment) -> ByteArray?,
        time: Long,
    ): ExportedArchive {
        val plan = plan(entries, readFile)
        val written = writeZip(out, plan, readFile, time)
        return ExportedArchive(written.files, plan.missing + written.missing)
    }

    /** First pass: which files can be read (each array zeroed at once) and their numbered archive paths. */
    private fun plan(entries: List<EntryContent>, readFile: (Attachment) -> ByteArray?): Plan {
        var numbered = 0
        var missing = 0
        val planned = sortForExport(entries).map { e ->
            val files = e.attachments.mapNotNull { a ->
                val bytes = readFile(a)
                if (bytes == null) {
                    missing++
                    null
                } else {
                    val size = bytes.size
                    bytes.fill(0)
                    Planned(a, archivePath(++numbered, a.name), size)
                }
            }
            PlannedEntry(e, files)
        }
        return Plan(planned, missing)
    }

    /** passholder.json: each entry's content, with its planned files described under `attachments`. */
    private fun indexJson(plan: Plan): JsonArray = JsonArray(
        plan.entries.map { entry ->
            val content = EntryCodec.contentJson(entry.content)
            if (entry.files.isEmpty()) {
                content
            } else {
                JsonObject(content + ("attachments" to JsonArray(entry.files.map(::describe))))
            }
        },
    )

    private fun describe(file: Planned) = JsonObject(
        linkedMapOf(
            "name" to JsonPrimitive(file.attachment.name),
            "mime" to JsonPrimitive(file.attachment.mime),
            "size" to JsonPrimitive(file.size),
            "path" to JsonPrimitive(file.path),
        ),
    )

    /**
     * Second pass: the index (zeroed afterwards) and then the planned files into a ZIP on [out], which stays open.
     * `missing` counts the files that could no longer be read.
     */
    private fun writeZip(out: OutputStream, plan: Plan, readFile: (Attachment) -> ByteArray?, time: Long): ExportedArchive {
        val index = PassHolderJson.text(indexJson(plan)).toByteArray(Charsets.UTF_8)
        var written = 0
        var missing = 0
        // Closing the ZIP stream frees its deflater; the caller's stream stays open.
        val keepOpen = object : FilterOutputStream(out) {
            override fun write(b: ByteArray, off: Int, len: Int) = out.write(b, off, len)
            override fun close() = flush()
        }
        ZipOutputStream(keepOpen).use { zip ->
            // The index is written first, so a reader that streams the archive (the phone) meets it before the files.
            zip.putNextEntry(ZipEntry(ARCHIVE_INDEX).also { it.time = time })
            try {
                zip.write(index)
            } finally {
                index.fill(0)
            }
            zip.closeEntry()
            for (f in plan.entries.flatMap { it.files }) {
                // Unavailable since the first pass: the index already describes it, the import reports it missing.
                val bytes = readFile(f.attachment)
                if (bytes == null) {
                    missing++
                    continue
                }
                try {
                    zip.putNextEntry(ZipEntry(f.path).also { it.time = time })
                    zip.write(bytes)
                    zip.closeEntry()
                } finally {
                    bytes.fill(0)
                }
                written++
            }
        }
        return ExportedArchive(written, missing)
    }
}
