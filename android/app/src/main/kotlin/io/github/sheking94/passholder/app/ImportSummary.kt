package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.p2p.ImportResult
import io.github.sheking94.passholder.core.transfer.ImportSkip
import io.github.sheking94.passholder.core.transfer.ParsedArchive
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

/** "1 plik", "3 pliki", "5 plików". */
fun filesNoun(n: Int): String = "$n ${plural(n, "plik", "pliki", "plików")}"

/** The files of an import: [added] stored with their entries, [skipped] left out (with where and why). */
data class ArchiveFiles(val added: Int, val skipped: List<ImportSkip>)

/** "at: reason; at: reason" for the first [LISTED_SKIPPED] items, then "; …" if there are more, otherwise ".". */
private fun listSkipped(skipped: List<ImportSkip>): String {
    val listed = skipped.take(LISTED_SKIPPED).joinToString("; ") { "${it.at}: ${it.reason}" }
    return "$listed${if (skipped.size > LISTED_SKIPPED) "; …" else "."}"
}

/**
 * The message shown after an import: what was added, what was skipped and why, and a reminder to delete the file.
 * Port of extension/src/import-summary.ts; on the phone the new entries reach the extension with the next sync.
 * [files] (a PassHolder ZIP, or files described in a bare passholder.json) adds how many files came in or were skipped.
 */
fun importSummary(parsed: ParsedImport, result: ImportResult, format: TransferFormat, files: ArchiveFiles? = null): String =
    summary(parsed.skipped, result, format, files)

/** The same message for a PassHolder ZIP. */
fun importSummary(parsed: ParsedArchive, result: ImportResult, format: TransferFormat, files: ArchiveFiles? = null): String =
    summary(parsed.skipped, result, format, files)

private fun summary(skipped: List<ImportSkip>, result: ImportResult, format: TransferFormat, files: ArchiveFiles?): String {
    fun noun(n: Int) = if (format == TransferFormat.NORDPASS) plural(n, "wiersz", "wiersze", "wierszy") else plural(n, "wpis", "wpisy", "wpisów")
    val fileSkips = files?.skipped.orEmpty()
    return listOfNotNull(
        "Dodano ${entriesNoun(result.added)} (zsynchronizuj, żeby trafiły do wtyczki).",
        if (result.duplicates > 0) "Pominięto ${result.duplicates} takich, które już są w sejfie lub powtarzają się w pliku." else null,
        if (result.tooLarge > 0) "Uwaga, pominięto za duże: ${result.tooLarge}." else null,
        if (skipped.isNotEmpty()) "Pominięto ${skipped.size} ${noun(skipped.size)}: ${listSkipped(skipped)}" else null,
        if (files != null && files.added > 0) "Dodano ${filesNoun(files.added)}." else null,
        if (fileSkips.isNotEmpty()) "Pominięto ${filesNoun(fileSkips.size)}: ${listSkipped(fileSkips)}" else null,
        "Usuń plik z dysku, zawiera hasła jawnym tekstem.",
    ).joinToString(" ")
}
