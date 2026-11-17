package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.files.Attachments
import io.github.sheking94.passholder.core.files.jsonInt
import io.github.sheking94.passholder.core.p2p.EntryCodec
import io.github.sheking94.passholder.core.p2p.EntryContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A file description in an archive index: exactly these keys, in this order. [path] only finds the file in the ZIP. */
data class ArchivedFile(val name: String, val mime: String, val size: Int, val path: String)

/**
 * An entry of an archive index: content without attachments, plus the descriptions of its files (may be empty).
 * [position] is the entry's place in the index's `entries` (from 1), the N of "wpis N".
 */
data class ArchiveEntry(val content: EntryContent, val files: List<ArchivedFile>, val position: Int)

data class ParsedArchive(val entries: List<ArchiveEntry>, val skipped: List<ImportSkip>)

/** PassHolder JSON v3 import and export; port of core/src/transfer/passholder-json.ts. */
object PassHolderJson {
    private const val NOT_PASSHOLDER = "To nie jest plik PassHolder w wersji 3"

    /** True for an object carrying the PassHolder format marker (used to detect the file kind). */
    fun isFormat(value: JsonElement): Boolean =
        value is JsonObject && (value["format"] as? JsonPrimitive)?.let { it.isString && it.content == "passholder" } == true

    fun export(entries: List<EntryContent>): String {
        val doc = JsonObject(
            linkedMapOf(
                "format" to JsonPrimitive("passholder"),
                "version" to JsonPrimitive(3),
                "entries" to JsonArray(sortForExport(entries).map(EntryCodec::contentJson)),
            ),
        )
        return JsonText.stringify(doc) + "\n"
    }

    private val FILE_KEYS = setOf("name", "mime", "size", "path")

    private fun fail(): Nothing = throw IllegalArgumentException()

    private fun string(value: JsonElement?): String {
        if (value !is JsonPrimitive || value is JsonNull || !value.isString) fail()
        return value.content
    }

    private fun parseArchivedFile(value: JsonElement): ArchivedFile {
        if (value !is JsonObject || value.keys != FILE_KEYS) fail()
        val name = string(value["name"])
        if (!Attachments.isName(name)) fail()
        val mime = string(value["mime"])
        if (!Attachments.isMime(mime)) fail()
        val size = jsonInt(value["size"], 1, Attachments.MAX_FILE_SIZE.toLong()) ?: fail()
        val path = string(value["path"])
        if (path == "") fail()
        return ArchivedFile(name, mime, size.toInt(), path)
    }

    private fun parseArchivedFiles(value: JsonElement?): List<ArchivedFile> {
        if (value !is JsonArray || value.size < 1 || value.size > Attachments.MAX_ATTACHMENTS_PARSED) fail()
        return value.map(::parseArchivedFile)
    }

    /**
     * The index of a PassHolder ZIP (also a PassHolder JSON v3 file): same rules as [parse], and an entry may carry
     * `attachments` with 1..40 file descriptions; a bad description, or a path described twice in the index, skips
     * the entry as "zły format wpisu". Port of parseArchiveIndex in core/src/transfer/passholder-json.ts.
     */
    fun parseArchiveIndex(text: String): ParsedArchive {
        val doc = try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            throw IllegalArgumentException(NOT_PASSHOLDER)
        }
        if (!isFormat(doc)) throw IllegalArgumentException(NOT_PASSHOLDER)
        val obj = doc as JsonObject
        val version = obj["version"] as? JsonPrimitive
        val raw = obj["entries"] as? JsonArray
        if (version == null || version.isString || version.content.toDoubleOrNull() != 3.0 || raw == null) {
            throw IllegalArgumentException(NOT_PASSHOLDER)
        }
        val entries = mutableListOf<ArchiveEntry>()
        val skipped = mutableListOf<ImportSkip>()
        // A path may be described once in the whole index, so one stored file cannot be imported many times.
        val paths = HashSet<String>()
        raw.forEachIndexed { i, item ->
            val position = i + 1
            val (content, files) = try {
                var files = emptyList<ArchivedFile>()
                var body = item
                if (item is JsonObject && item.containsKey("attachments")) {
                    files = parseArchivedFiles(item["attachments"])
                    body = JsonObject(item - "attachments")
                }
                val content = EntryCodec.parseContent(body)
                val own = files.map { it.path }
                if (own.toSet().size != own.size || own.any { it in paths }) fail()
                content to files
            } catch (_: Exception) {
                skipped.add(ImportSkip("wpis $position", "zły format wpisu"))
                return@forEachIndexed
            }
            if (content.name.jsTrim() == "") {
                skipped.add(ImportSkip("wpis $position", "brak nazwy"))
            } else {
                files.forEach { paths.add(it.path) }
                entries.add(ArchiveEntry(content, files, position))
            }
        }
        return ParsedArchive(entries, skipped)
    }

    /**
     * Throws a Polish message if the file is not PassHolder JSON v3; a bad entry is skipped as "wpis N" (from 1).
     * File descriptions of an archive index are left out and listed in [ParsedImport.files] ("wpis N, nazwa"),
     * since the files themselves are only in the ZIP.
     */
    fun parse(text: String): ParsedImport {
        val (entries, skipped) = parseArchiveIndex(text)
        val files = entries.flatMap { e -> e.files.map { ImportSkip("wpis ${e.position}, ${it.name}", "importuj całe archiwum ZIP") } }
        return ParsedImport(entries.map { it.content }, skipped, files)
    }
}
