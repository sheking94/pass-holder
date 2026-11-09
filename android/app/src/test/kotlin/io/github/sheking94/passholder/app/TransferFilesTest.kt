package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.transfer.TransferFormat
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.time.LocalDate

/** Reading an import file: at most 10 MiB, strict UTF-8; the default export file name. */
class TransferFilesTest {
    @Test
    fun `a file of exactly 10 MiB is read, one byte more is refused`() {
        val limit = ByteArray(TransferFiles.MAX_BYTES) { 'a'.code.toByte() }
        assertArrayEquals(limit, TransferFiles.readCapped(ByteArrayInputStream(limit)))
        val e = assertThrows(IllegalArgumentException::class.java) {
            TransferFiles.readCapped(ByteArrayInputStream(ByteArray(TransferFiles.MAX_BYTES + 1)))
        }
        assertEquals("Plik jest za duży (limit 10 MiB)", e.message)
    }

    @Test
    fun `strict UTF-8, Windows-1250 is refused`() {
        assertEquals("Zażółć", TransferFiles.decode("Zażółć".toByteArray(Charsets.UTF_8)))
        val e = assertThrows(IllegalArgumentException::class.java) {
            TransferFiles.decode("Zażółć".toByteArray(charset("windows-1250")))
        }
        assertEquals("Plik nie jest zapisany w UTF-8", e.message)
    }

    @Test
    fun `default export file name`() {
        val day = LocalDate.of(2026, 11, 9)
        assertEquals("passholder-2026-11-09.json", TransferFiles.defaultFileName(TransferFormat.PASSHOLDER, day))
        assertEquals("passholder-2026-11-09.json", TransferFiles.defaultFileName(TransferFormat.BITWARDEN, day))
        assertEquals("passholder-2026-11-09.csv", TransferFiles.defaultFileName(TransferFormat.NORDPASS, day))
    }

    @Test
    fun `provider failures on read are Polish`() {
        for (failure in listOf<() -> java.io.InputStream?>(
            { throw java.io.FileNotFoundException("open failed: ENOENT") },
            { throw SecurityException("Permission Denial") },
            { null },
            { object : java.io.InputStream() { override fun read() = throw java.io.IOException("EIO") } },
        )) {
            val e = assertThrows(java.io.IOException::class.java) { TransferFiles.readText(failure) }
            assertEquals("Nie udało się odczytać pliku.", e.message)
        }
    }

    @Test
    fun `read keeps the size and UTF-8 messages`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            TransferFiles.readText { ByteArrayInputStream("Zażółć".toByteArray(charset("windows-1250"))) }
        }
        assertEquals("Plik nie jest zapisany w UTF-8", e.message)
    }

    @Test
    fun `provider failures on write are Polish`() {
        val expected = "Nie udało się zapisać pliku. Jeśli plik powstał, usuń go, bo może zawierać hasła."
        for (failure in listOf<() -> java.io.OutputStream?>(
            { throw java.io.FileNotFoundException("open failed") },
            { throw SecurityException("Permission Denial") },
            { null },
            { object : java.io.OutputStream() { override fun write(b: Int) = throw java.io.IOException("ENOSPC") } },
        )) {
            val e = assertThrows(java.io.IOException::class.java) { TransferFiles.writeText("x", failure) }
            assertEquals(expected, e.message)
        }
    }
}
