package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.EntryV3
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** PassHolder JSON v3 import and export; port of core/src/transfer/passholder-json.ts. */
object PassHolderJson {
    private const val NOT_PASSHOLDER = "To nie jest plik PassHolder w wersji 3"

    /** True for an object carrying the PassHolder format marker (used to detect the file kind). */
    fun isFormat(value: JsonElement): Boolean =
        value is JsonObject && (value["format"] as? JsonPrimitive)?.let { it.isString && it.content == "passholder" } == true

    fun export(entries: List<EntryContentV3>): String {
        val doc = JsonObject(
            linkedMapOf(
                "format" to JsonPrimitive("passholder"),
                "version" to JsonPrimitive(3),
                "entries" to JsonArray(sortForExport(entries).map(EntryV3::contentJson)),
            ),
        )
        return JsonText.stringify(doc) + "\n"
    }

    /** Throws a Polish message if the file is not PassHolder JSON v3; a bad entry is skipped as "wpis N" (from 1). */
    fun parse(text: String): ParsedImport {
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
        val entries = mutableListOf<EntryContentV3>()
        val skipped = mutableListOf<ImportSkip>()
        raw.forEachIndexed { i, item ->
            val entry = try {
                EntryV3.parseContent(item)
            } catch (_: Exception) {
                skipped.add(ImportSkip("wpis ${i + 1}", "zły format wpisu"))
                return@forEachIndexed
            }
            if (entry.name.jsTrim() == "") skipped.add(ImportSkip("wpis ${i + 1}", "brak nazwy")) else entries.add(entry)
        }
        return ParsedImport(entries, skipped)
    }
}
