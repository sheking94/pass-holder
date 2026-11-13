package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.p2p.ImportResult
import io.github.sheking94.passholder.core.transfer.ParsedImport
import io.github.sheking94.passholder.core.transfer.TransferFormat

/** How many skipped items the summary lists one by one; the rest is shown as "…". */
private const val LISTED_SKIPPED = 5

/** The Polish noun form for a count: 1 → one, 2–4 (not 12–14) → few, otherwise many. Port of extension/src/plural.ts. */
fun plural(n: Int, one: String, few: String, many: String): String {
    if (n == 1) return one
    val last = n % 10
    val lastTwo = n % 100
    return if (last in 2..4 && lastTwo !in 12..14) few else many
}

/** "1 wpis", "3 wpisy", "5 wpisów". */
fun entriesNoun(n: Int): String = "$n ${plural(n, "wpis", "wpisy", "wpisów")}"

/** "1 plik nie zostanie wyeksportowany", "2 pliki nie zostaną wyeksportowane", "5 plików nie zostanie wyeksportowanych". */
fun skippedFilesPhrase(n: Int): String =
    "$n ${plural(n, "plik nie zostanie wyeksportowany", "pliki nie zostaną wyeksportowane", "plików nie zostanie wyeksportowanych")}"

/**
 * The message shown after an import: what was added, what was skipped and why, and a reminder to delete the file.
 * Port of extension/src/import-summary.ts; on the phone the new entries reach the extension with the next sync.
 */
fun importSummary(parsed: ParsedImport, result: ImportResult, format: TransferFormat): String {
    val skipped = parsed.skipped
    fun noun(n: Int) = if (format == TransferFormat.NORDPASS) plural(n, "wiersz", "wiersze", "wierszy") else plural(n, "wpis", "wpisy", "wpisów")
    val listed = skipped.take(LISTED_SKIPPED).joinToString("; ") { "${it.at}: ${it.reason}" }
    return listOfNotNull(
        "Dodano ${entriesNoun(result.added)} (zsynchronizuj, żeby trafiły do wtyczki).",
        if (result.duplicates > 0) "Pominięto ${result.duplicates} takich, które już są w sejfie lub powtarzają się w pliku." else null,
        if (result.tooLarge > 0) "Uwaga, pominięto za duże: ${result.tooLarge}." else null,
        if (skipped.isNotEmpty()) {
            "Pominięto ${skipped.size} ${noun(skipped.size)}: $listed${if (skipped.size > LISTED_SKIPPED) "; …" else "."}"
        } else {
            null
        },
        "Usuń plik z dysku, zawiera hasła jawnym tekstem.",
    ).joinToString(" ")
}
