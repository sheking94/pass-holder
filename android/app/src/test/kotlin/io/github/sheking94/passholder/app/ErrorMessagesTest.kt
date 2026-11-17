package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorMessagesTest {
    @Test
    fun everyCodeHasAPolishText() {
        for (code in ErrorCode.entries) {
            val text = errorMessage(PassHolderException(code))
            assertTrue(code.name, text.isNotBlank() && text != code.name)
        }
    }

    @Test
    fun textsKeepWhatTheUserSawBefore() {
        assertEquals("Złe hasło główne", errorMessage(PassHolderException(ErrorCode.WRONG_MASTER_PASSWORD)))
        assertEquals("Sejf jest zablokowany", errorMessage(PassHolderException(ErrorCode.VAULT_LOCKED)))
        assertEquals("Plik jest uszkodzony", errorMessage(PassHolderException(ErrorCode.FILE_CORRUPTED)))
        assertEquals("Długość musi być od 4 do 128", errorMessage(PassHolderException(ErrorCode.GENERATOR_BAD_LENGTH)))
        assertEquals(
            "Plik CSV jest uszkodzony: niezamknięty cudzysłów (wiersz 7)",
            errorMessage(PassHolderException(ErrorCode.IMPORT_CSV_UNCLOSED_QUOTE, detail = "7")),
        )
    }

    @Test
    fun otherErrorsShowTheirMessageOrClassName() {
        assertEquals("Nie udało się odczytać pliku.", errorMessage(java.io.IOException("Nie udało się odczytać pliku.")))
        assertEquals("IllegalStateException", errorMessage(IllegalStateException()))
    }
}
