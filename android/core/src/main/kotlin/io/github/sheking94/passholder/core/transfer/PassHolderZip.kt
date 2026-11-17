package io.github.sheking94.passholder.core.transfer

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

/**
 * PassHolder ZIP: passholder.json (a PassHolder JSON v3 index whose entries describe their files) followed by the
 * decrypted files under files/<n>-<name>; port of core/src/transfer/passholder-zip.ts. Paths from an archive are only
 * used to look entries up in the ZIP, never as file system paths.
 */
object PassHolderZip {
    const val MAX_ZIP_BYTES = 268435456L
    const val ARCHIVE_INDEX = "passholder.json"

    /** Largest passholder.json accepted, after inflating. */
    internal const val MAX_INDEX_BYTES = 10485760

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

    private class Planned(val attachment: Attachment, val path: String, val size: Int)

    internal fun export(
        entries: List<EntryContent>,
        out: OutputStream,
        readFile: (Attachment) -> ByteArray?,
        time: Long,
    ): ExportedArchive {
        var numbered = 0
        var missing = 0
        val plan = sortForExport(entries).map { e ->
            e to e.attachments.mapNotNull { a ->
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
        }
        val index = JsonArray(
            plan.map { (e, files) ->
                val content = EntryCodec.contentJson(e)
                if (files.isEmpty()) {
                    content
                } else {
                    val described = files.map {
                        JsonObject(
                            linkedMapOf(
                                "name" to JsonPrimitive(it.attachment.name),
                                "mime" to JsonPrimitive(it.attachment.mime),
                                "size" to JsonPrimitive(it.size),
                                "path" to JsonPrimitive(it.path),
                            ),
                        )
                    }
                    JsonObject(content + ("attachments" to JsonArray(described)))
                }
            },
        )
        val doc = JsonObject(linkedMapOf("format" to JsonPrimitive("passholder"), "version" to JsonPrimitive(3), "entries" to index))
        val json = (JsonText.stringify(doc) + "\n").toByteArray(Charsets.UTF_8)
        var files = 0
        // Closing the ZIP stream frees its deflater; the caller's stream stays open.
        val keepOpen = object : FilterOutputStream(out) {
            override fun write(b: ByteArray, off: Int, len: Int) = out.write(b, off, len)
            override fun close() = flush()
        }
        ZipOutputStream(keepOpen).use { zip ->
            // The index is written first, so a reader that streams the archive (the phone) meets it before the files.
            zip.putNextEntry(ZipEntry(ARCHIVE_INDEX).also { it.time = time })
            try {
                zip.write(json)
            } finally {
                json.fill(0)
            }
            zip.closeEntry()
            for (f in plan.flatMap { it.second }) {
                // Unavailable since the first pass: the index already describes it, the import reports it missing.
                val bytes = readFile(f.attachment) ?: run {
                    missing++
                    null
                } ?: continue
                try {
                    zip.putNextEntry(ZipEntry(f.path).also { it.time = time })
                    zip.write(bytes)
                    zip.closeEntry()
                } finally {
                    bytes.fill(0)
                }
                files++
            }
        }
        return ExportedArchive(files, missing)
    }
}
