package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class TransferTest {
    private fun fail(text: String) = assertThrows<PassHolderException> { Transfer.parseImportFile(text) }.code

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
        assertEquals(ErrorCode.IMPORT_EMPTY_FILE, fail(""))
        assertEquals(ErrorCode.IMPORT_EMPTY_FILE, fail(" \n "))
        assertEquals(ErrorCode.IMPORT_BAD_JSON, fail("{zły"))
        assertEquals(ErrorCode.IMPORT_UNKNOWN_FORMAT, fail("""{"x":1}"""))
    }

    @Test
    fun encryptedBitwardenShowsItsOwnMessage() {
        assertEquals(ErrorCode.IMPORT_BITWARDEN_ENCRYPTED, fail("""{"encrypted":true,"items":[]}"""))
        val protectedFile =
            """{"encrypted":true,"passwordProtected":true,"salt":"c2FsdA==","kdfType":0,"kdfIterations":600000,""" +
                """"encKeyValidation_DO_NOT_EDIT":"2.x","data":"2.y"}"""
        assertEquals(ErrorCode.IMPORT_BITWARDEN_ENCRYPTED, fail(protectedFile))
    }

    @Test
    fun everyExportIsRecognisedAgain() {
        val entries = Transfer.parseImportFile(readVector("passholder.json")).parsed.entries
        for (f in TransferFormat.entries) {
            assertEquals(f, Transfer.parseImportFile(Transfer.exportFile(f, entries)).format)
        }
    }
}
