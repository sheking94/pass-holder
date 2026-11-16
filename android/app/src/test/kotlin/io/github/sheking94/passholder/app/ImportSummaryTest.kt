package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.p2p.ImportResult
import io.github.sheking94.passholder.core.transfer.ImportSkip
import io.github.sheking94.passholder.core.transfer.ParsedArchive
import io.github.sheking94.passholder.core.transfer.ParsedImport
import io.github.sheking94.passholder.core.transfer.TransferFormat
import org.junit.Assert.assertEquals
import org.junit.Test

/** The message after an import, ported from extension/src/import-summary.ts (the "added" sentence says where the entries go next). */
class ImportSummaryTest {
    private val nothingSkipped = ParsedImport(emptyList(), emptyList())
    private val end = "Usuń plik z dysku, zawiera hasła jawnym tekstem."

    @Test
    fun `one entry added, nothing else`() {
        assertEquals(
            "Dodano 1 wpis (zsynchronizuj, żeby trafiły do wtyczki). $end",
            importSummary(nothingSkipped, ImportResult(1, 0, 0), TransferFormat.PASSHOLDER),
        )
    }

    @Test
    fun `three added, duplicates and too large ones`() {
        assertEquals(
            "Dodano 3 wpisy (zsynchronizuj, żeby trafiły do wtyczki). " +
                "Pominięto 2 takich, które już są w sejfie lub powtarzają się w pliku. Uwaga, pominięto za duże: 1. $end",
            importSummary(nothingSkipped, ImportResult(3, 2, 1), TransferFormat.BITWARDEN),
        )
    }

    @Test
    fun `five added, more than five skipped are cut with an ellipsis`() {
        val skipped = (1..6).map { ImportSkip("wpis $it", "brak nazwy") }
        assertEquals(
            "Dodano 5 wpisów (zsynchronizuj, żeby trafiły do wtyczki). Pominięto 6 wpisów: " +
                "wpis 1: brak nazwy; wpis 2: brak nazwy; wpis 3: brak nazwy; wpis 4: brak nazwy; wpis 5: brak nazwy; … $end",
            importSummary(ParsedImport(emptyList(), skipped), ImportResult(5, 0, 0), TransferFormat.BITWARDEN),
        )
    }

    @Test
    fun `NordPass counts skipped rows, up to five listed in full`() {
        val skipped = listOf(ImportSkip("wiersz 3", "nieznany typ"), ImportSkip("wiersz 4", "brak nazwy"))
        assertEquals(
            "Dodano 0 wpisów (zsynchronizuj, żeby trafiły do wtyczki). Pominięto 2 wiersze: wiersz 3: nieznany typ; wiersz 4: brak nazwy. $end",
            importSummary(ParsedImport(emptyList(), skipped), ImportResult(0, 0, 0), TransferFormat.NORDPASS),
        )
        val five = (1..5).map { ImportSkip("wiersz $it", "x") }
        assertEquals(
            "Dodano 12 wpisów (zsynchronizuj, żeby trafiły do wtyczki). Pominięto 5 wierszy: " +
                "wiersz 1: x; wiersz 2: x; wiersz 3: x; wiersz 4: x; wiersz 5: x. $end",
            importSummary(ParsedImport(emptyList(), five), ImportResult(12, 0, 0), TransferFormat.NORDPASS),
        )
        assertEquals(
            "Dodano 22 wpisy (zsynchronizuj, żeby trafiły do wtyczki). Pominięto 1 wiersz: wiersz 2: x. $end",
            importSummary(ParsedImport(emptyList(), listOf(ImportSkip("wiersz 2", "x"))), ImportResult(22, 0, 0), TransferFormat.NORDPASS),
        )
    }

    @Test
    fun `filesNoun agrees with the count`() {
        assertEquals(listOf("1 plik", "2 pliki", "5 plików", "22 pliki", "12 plików"), listOf(1, 2, 5, 22, 12).map(::filesNoun))
    }

    @Test
    fun `the export sentence for left-out files agrees with the count`() {
        assertEquals(
            listOf(
                "Pominięto 1 plik, który czeka na synchronizację albo jest uszkodzony.",
                "Pominięto 3 pliki, które czekają na synchronizację albo są uszkodzone.",
                "Pominięto 5 plików, które czekają na synchronizację albo są uszkodzone.",
            ),
            listOf(1, 3, 5).map(::missingFilesSentence),
        )
    }

    @Test
    fun `an archive adds files after the entry sentences`() {
        assertEquals(
            "Dodano 1 wpis (zsynchronizuj, żeby trafiły do wtyczki). Dodano 3 pliki. $end",
            importSummary(
                ParsedArchive(emptyList(), emptyList()),
                ImportResult(1, 0, 0),
                TransferFormat.PASSHOLDER,
                ArchiveFiles(3, emptyList()),
            ),
        )
    }

    @Test
    fun `skipped files are listed up to five, no sentence for zero added files`() {
        val six = (1..6).map { ImportSkip("wpis $it, a$it.pdf", "uszkodzony") }
        val text =
            importSummary(ParsedArchive(emptyList(), emptyList()), ImportResult(6, 0, 0), TransferFormat.PASSHOLDER, ArchiveFiles(1, six))
        assertEquals(
            "Dodano 6 wpisów (zsynchronizuj, żeby trafiły do wtyczki). Dodano 1 plik. Pominięto 6 plików: " +
                "wpis 1, a1.pdf: uszkodzony; wpis 2, a2.pdf: uszkodzony; wpis 3, a3.pdf: uszkodzony; wpis 4, a4.pdf: uszkodzony; " +
                "wpis 5, a5.pdf: uszkodzony; … $end",
            text,
        )
        val one = importSummary(
            ParsedArchive(emptyList(), listOf(ImportSkip("wpis 2", "brak nazwy"))),
            ImportResult(1, 1, 0),
            TransferFormat.PASSHOLDER,
            ArchiveFiles(0, listOf(ImportSkip("wpis 1, a1.pdf", "uszkodzony"))),
        )
        assertEquals(
            "Dodano 1 wpis (zsynchronizuj, żeby trafiły do wtyczki). Pominięto 1 takich, które już są w sejfie lub powtarzają się w pliku. " +
                "Pominięto 1 wpis: wpis 2: brak nazwy. Pominięto 1 plik: wpis 1, a1.pdf: uszkodzony. $end",
            one,
        )
    }

    @Test
    fun `a bare passholder json lists its dropped files as skipped`() {
        val parsed = ParsedImport(emptyList(), emptyList(), listOf(ImportSkip("wpis 1, a.pdf", "importuj całe archiwum ZIP")))
        assertEquals(
            "Dodano 1 wpis (zsynchronizuj, żeby trafiły do wtyczki). Pominięto 1 plik: wpis 1, a.pdf: importuj całe archiwum ZIP. $end",
            importSummary(parsed, ImportResult(1, 0, 0), TransferFormat.PASSHOLDER, ArchiveFiles(0, parsed.files)),
        )
    }
}
