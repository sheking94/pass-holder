package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.p2p.ImportResult
import io.github.sheking94.passholder.core.transfer.ImportSkip
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
}
