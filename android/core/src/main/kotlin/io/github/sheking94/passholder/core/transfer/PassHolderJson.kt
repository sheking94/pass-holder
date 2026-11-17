package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.StrictJson
import io.github.sheking94.passholder.core.files.Attachments
import io.github.sheking94.passholder.core.files.jsonInt
import io.github.sheking94.passholder.core.p2p.EntryCodec
import io.github.sheking94.passholder.core.p2p.EntryContent
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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
    private const val FORMAT = "passholder"
    private const val VERSION = 3

    /** The text of a PassHolder JSON file or archive index: format marker, version and entries, pretty-printed. */
    internal fun text(entries: JsonArray): String = JsonText.stringify(
        JsonObject(linkedMapOf("format" to JsonPrimitive(FORMAT), "version" to JsonPrimitive(VERSION), "entries" to entries)),
    ) + "\n"

    /** True for an object carrying the PassHolder format marker (used to detect the file kind). */
    fun isFormat(value: JsonElement): Boolean =
        value is JsonObject && (value["format"] as? JsonPrimitive)?.let { it.isString && it.content == FORMAT } == true

    fun export(entries: List<EntryContent>): String = text(JsonArray(sortForExport(entries).map(EntryCodec::contentJson)))

    private val FILE_KEYS = setOf("name", "mime", "size", "path")

    /** A file description, or null when it breaks a rule. */
    private fun parseArchivedFile(value: JsonElement): ArchivedFile? {
        if (value !is JsonObject || value.keys != FILE_KEYS) return null
        val name = StrictJson.string(value["name"])?.takeIf(Attachments::isName) ?: return null
        val mime = StrictJson.string(value["mime"])?.takeIf(Attachments::isMime) ?: return null
        val size = jsonInt(value["size"], 1, Attachments.MAX_FILE_SIZE.toLong()) ?: return null
        val path = StrictJson.string(value["path"])?.takeIf { it != "" } ?: return null
        return ArchivedFile(name, mime, size.toInt(), path)
    }

    /** 1..MAX_ATTACHMENTS_PARSED file descriptions, or null when the list or any description is bad. */
    private fun parseArchivedFiles(value: JsonElement?): List<ArchivedFile>? {
        if (value !is JsonArray || value.size < 1 || value.size > Attachments.MAX_ATTACHMENTS_PARSED) return null
        return value.map { parseArchivedFile(it) ?: return null }
    }

    /** An index item as its content and file descriptions, or null when its format is bad. */
    private fun parseIndexItem(item: JsonElement): Pair<EntryContent, List<ArchivedFile>>? {
        var files = emptyList<ArchivedFile>()
        var body = item
        if (item is JsonObject && item.containsKey("attachments")) {
            files = parseArchivedFiles(item["attachments"]) ?: return null
            body = JsonObject(item - "attachments")
        }
        return try {
            EntryCodec.parseContent(body) to files
        } catch (_: IllegalArgumentException) {
            // parseContent throws "Invalid entry payload" for any rule the content breaks.
            null
        }
    }

    private fun notPassHolder(cause: Throwable? = null) =
        PassHolderException(ErrorCode.IMPORT_NOT_PASSHOLDER, "Not a PassHolder JSON v3 file", cause = cause)

    /**
     * The index of a PassHolder ZIP (also a PassHolder JSON v3 file): same rules as [parse], and an entry may carry
     * `attachments` with 1..40 file descriptions; a bad description, or a path described twice in the index, skips
     * the entry as "zły format wpisu". Port of parseArchiveIndex in core/src/transfer/passholder-json.ts.
     */
    fun parseArchiveIndex(text: String): ParsedArchive {
        val doc = try {
            Json.parseToJsonElement(text)
        } catch (e: SerializationException) {
            throw notPassHolder(e)
        }
        if (!isFormat(doc)) throw notPassHolder()
        val obj = doc as JsonObject
        val version = obj["version"] as? JsonPrimitive
        val raw = obj["entries"] as? JsonArray
        if (version == null || version.isString || version.content.toDoubleOrNull() != 3.0 || raw == null) {
            throw notPassHolder()
        }
        val entries = mutableListOf<ArchiveEntry>()
        val skipped = mutableListOf<ImportSkip>()
        // A path may be described once in the whole index, so one stored file cannot be imported many times.
        val paths = HashSet<String>()
        raw.forEachIndexed { i, item ->
            val position = i + 1
            val parsed = parseIndexItem(item)
            val own = parsed?.second.orEmpty().map { it.path }
            if (parsed == null || own.toSet().size != own.size || own.any { it in paths }) {
                skipped.add(ImportSkip("wpis $position", SKIP_BAD_ENTRY))
                return@forEachIndexed
            }
            val (content, files) = parsed
            if (content.name.jsTrim() == "") {
                skipped.add(ImportSkip("wpis $position", SKIP_NO_NAME))
            } else {
                files.forEach { paths.add(it.path) }
                entries.add(ArchiveEntry(content, files, position))
            }
        }
        return ParsedArchive(entries, skipped)
    }

    /**
     * Throws [ErrorCode.IMPORT_NOT_PASSHOLDER] if the file is not PassHolder JSON v3; a bad entry is skipped as "wpis N" (from 1).
     * File descriptions of an archive index are left out and listed in [ParsedImport.files] ("wpis N, nazwa"),
     * since the files themselves are only in the ZIP.
     */
    fun parse(text: String): ParsedImport {
        val (entries, skipped) = parseArchiveIndex(text)
        val files = entries.flatMap { e -> e.files.map { ImportSkip("wpis ${e.position}, ${it.name}", "importuj całe archiwum ZIP") } }
        return ParsedImport(entries.map { it.content }, skipped, files)
    }
}
