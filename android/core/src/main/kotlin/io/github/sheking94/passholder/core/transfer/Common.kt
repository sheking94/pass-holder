package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.EntryV3
import io.github.sheking94.passholder.core.p2p.PostalAddress
import java.text.Collator
import java.text.RuleBasedCollator
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** An entry or row an importer did not take. [at] is ready to show, e.g. "wiersz 3" (CSV, header is row 1) or "wpis 2" (JSON, from 1). */
data class ImportSkip(val at: String, val reason: String)

data class ParsedImport(val entries: List<EntryContentV3>, val skipped: List<ImportSkip>)

/** Order of entry types in exports when names are equal. */
val ENTRY_TYPE_ORDER = listOf("login", "contact", "card", "note", "document")

private fun trimmed(v: JsonElement): JsonElement = when (v) {
    is JsonPrimitive -> if (v.isString) JsonPrimitive(v.content.jsTrim()) else v
    is JsonArray -> JsonArray(v.map(::trimmed))
    is JsonObject -> JsonObject(v.entries.sortedBy { it.key }.associate { it.key to trimmed(it.value) })
}


/** Equal keys mean a duplicate: same whole content, every text trimmed at its edges, object keys in sorted order. */
fun contentKey(c: EntryContentV3): String = JsonText.stringify(trimmed(EntryV3.contentJson(c)))

/**
 * Polish collation matching Node's `localeCompare(..., "pl")` (ICU, punctuation not ignorable). The JDK's `pl` collator
 * ignores spaces and punctuation, so its rules are extended: whitespace and the ICU-ordered punctuation/symbols become
 * primary-different characters sorting before digits. Verified against core/test-vectors/transfer/sort.json.
 * Known difference: the apostrophe cannot be expressed in JDK rules and, like control characters, stays ignorable.
 */
private val POLISH_COLLATOR: Collator = run {
    val base = Collator.getInstance(Locale.forLanguageTag("pl")) as RuleBasedCollator
    val order = " _-,;:!?.\"()[]{}@*/\\&#%`^+<=>|~$"
    val rules = order.toList().joinToString(" < ", prefix = "& '\u0000' < ") { "'$it'" }
    RuleBasedCollator(base.rules + rules)
}

/**
 * A copy sorted by name ([POLISH_COLLATOR], default strength), then by type in [ENTRY_TYPE_ORDER].
 * Differs from the plain JDK collator only in not ignoring spaces and punctuation (see [POLISH_COLLATOR]).
 */
fun sortForExport(entries: List<EntryContentV3>): List<EntryContentV3> =
    entries.sortedWith { a, b ->
        val byName = POLISH_COLLATOR.compare(a.name, b.name)
        if (byName != 0) byName else ENTRY_TYPE_ORDER.indexOf(a.fields.type) - ENTRY_TYPE_ORDER.indexOf(b.fields.type)
    }

/** "Telefon (etykieta)", or just "Telefon" when the label is empty. Used for extra phones, e-mails and addresses on export. */
fun labelled(name: String, label: String): String = if (label == "") name else "$name ($label)"

/** "ulica, kod miasto, kraj" with empty parts left out. */
fun addressLine(a: PostalAddress): String =
    listOf(a.street, listOf(a.postalCode, a.city).filter { it != "" }.joinToString(" "), a.country).filter { it != "" }.joinToString(", ")
