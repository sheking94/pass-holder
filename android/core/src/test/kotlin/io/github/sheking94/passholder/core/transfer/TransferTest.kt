package io.github.sheking94.passholder.core.transfer

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class TransferTest {
    private fun fail(text: String) = assertThrows<IllegalArgumentException> { Transfer.parseImportFile(text) }.message

    @Test
    fun recognisesSampleFiles() {
        for ((name, format) in listOf(
            "passholder.json" to TransferFormat.PASSHOLDER,
            "bitwarden.json" to TransferFormat.BITWARDEN,
            "nordpass.csv" to TransferFormat.NORDPASS,
            "nordpass-typed.csv" to TransferFormat.NORDPASS,
        )) {
            val r = Transfer.parseImportFile(readVector(name))
            assertEquals(format, r.format, name)
            assertTrue(r.parsed.entries.isNotEmpty(), name)
        }
    }

    @Test
    fun ignoresBomAndLeadingSpaces() =
        assertEquals(TransferFormat.PASSHOLDER, Transfer.parseImportFile("\uFEFF  \n" + readVector("passholder.json")).format)

    @Test
    fun reportsEmptyBrokenOrUnknownFile() {
        assertEquals("Plik jest pusty", fail(""))
        assertEquals("Plik jest pusty", fail(" \n "))
        assertEquals("Plik JSON jest uszkodzony", fail("{zły"))
        assertEquals("Nie rozpoznano pliku: to nie jest eksport PassHolder, Bitwarden ani NordPass", fail("""{"x":1}"""))
    }

    @Test
    fun encryptedBitwardenShowsItsOwnMessage() {
        assertTrue(fail("""{"encrypted":true,"items":[]}""")!!.contains("Zaszyfrowany eksport Bitwarden"))
        val protectedFile = """{"encrypted":true,"passwordProtected":true,"salt":"c2FsdA==","kdfType":0,"kdfIterations":600000,"encKeyValidation_DO_NOT_EDIT":"2.x","data":"2.y"}"""
        assertTrue(fail(protectedFile)!!.contains("Zaszyfrowany eksport Bitwarden"))
    }

    @Test
    fun everyExportIsRecognisedAgain() {
        val entries = Transfer.parseImportFile(readVector("passholder.json")).parsed.entries
        for (f in TransferFormat.entries) {
            assertEquals(f, Transfer.parseImportFile(Transfer.exportFile(f, entries)).format)
        }
    }
}
