package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.transfer.TransferFormat
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
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
        assertEquals("passholder-2026-11-09.zip", TransferFiles.defaultFileName(TransferFormat.PASSHOLDER, day, zip = true))
    }

    @Test
    fun `a ZIP is recognised by its first four bytes`() {
        assertTrue(TransferFiles.isZip { ByteArrayInputStream(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14, 0x00)) })
        // Read in pieces, as a provider may hand them out.
        val trickle = object : java.io.InputStream() {
            private val bytes = byteArrayOf(0x50, 0x4B, 0x03, 0x04)
            private var i = 0
            override fun read() = if (i < bytes.size) bytes[i++].toInt() else -1
            override fun read(b: ByteArray, off: Int, len: Int): Int = if (i < bytes.size) {
                b[off] = bytes[i++]
                1
            } else {
                -1
            }
        }
        assertTrue(TransferFiles.isZip { trickle })
        assertFalse(TransferFiles.isZip { ByteArrayInputStream("{\"format\":\"passholder\"}".toByteArray()) })
        assertFalse(TransferFiles.isZip { ByteArrayInputStream(ByteArray(0)) })
        assertFalse(TransferFiles.isZip { ByteArrayInputStream(byteArrayOf(0x50, 0x4B, 0x03)) })
        // An empty archive (end record only) is not a PassHolder ZIP.
        assertFalse(TransferFiles.isZip { ByteArrayInputStream(byteArrayOf(0x50, 0x4B, 0x05, 0x06)) })
    }

    @Test
    fun `provider failures while checking for a ZIP are Polish`() {
        for (failure in listOf<() -> java.io.InputStream?>(
            { throw java.io.FileNotFoundException("open failed: ENOENT") },
            { throw SecurityException("Permission Denial") },
            { null },
            {
                object : java.io.InputStream() {
                    override fun read() = throw java.io.IOException("EIO")
                }
            },
        )) {
            val e = assertThrows(java.io.IOException::class.java) { TransferFiles.isZip(failure) }
            assertEquals("Nie udało się odczytać pliku.", e.message)
        }
    }

    @Test
    fun `provider failures while streaming an archive are Polish`() {
        for (failure in listOf<() -> java.io.InputStream?>(
            { throw java.io.FileNotFoundException("open failed: ENOENT") },
            { throw SecurityException("Permission Denial") },
            { null },
        )) {
            val e = assertThrows(java.io.IOException::class.java) { TransferFiles.openArchive(failure) }
            assertEquals("Nie udało się odczytać pliku.", e.message)
        }
        val broken = TransferFiles.openArchive {
            object : java.io.InputStream() {
                override fun read() = throw java.io.IOException("EIO")
            }
        }
        assertEquals("Nie udało się odczytać pliku.", assertThrows(java.io.IOException::class.java) { broken.read(ByteArray(4)) }.message)
        assertArrayEquals(byteArrayOf(1, 2), TransferFiles.openArchive { ByteArrayInputStream(byteArrayOf(1, 2)) }.readBytes())
    }

    @Test
    fun `provider failures while writing an archive are Polish, the archive's own errors too`() {
        val expected = "Nie udało się zapisać pliku. Jeśli plik powstał, usuń go, bo może zawierać hasła."
        for (failure in listOf<() -> java.io.OutputStream?>(
            { throw java.io.FileNotFoundException("open failed") },
            { throw SecurityException("Permission Denial") },
            { null },
            {
                object : java.io.OutputStream() {
                    override fun write(b: Int) = throw java.io.IOException("ENOSPC")
                }
            },
        )) {
            val e = assertThrows(java.io.IOException::class.java) { TransferFiles.writeArchive(failure) { it.write(ByteArray(10)) } }
            assertEquals(expected, e.message)
        }
        // The vault locked half way: part of the archive may be on disk, so the message says to delete it.
        val e = assertThrows(java.io.IOException::class.java) {
            TransferFiles.writeArchive({ java.io.ByteArrayOutputStream() }) { throw PassHolderException(ErrorCode.VAULT_LOCKED) }
        }
        assertEquals(expected, e.message)
        // Cancellation and programming errors are not disguised as a write failure.
        assertThrows(kotlinx.coroutines.CancellationException::class.java) {
            TransferFiles.writeArchive({ java.io.ByteArrayOutputStream() }) { throw kotlinx.coroutines.CancellationException("stop") }
        }
        val corrupted = assertThrows(PassHolderException::class.java) {
            TransferFiles.writeArchive({ java.io.ByteArrayOutputStream() }) { throw PassHolderException(ErrorCode.FILE_CORRUPTED) }
        }
        assertEquals(ErrorCode.FILE_CORRUPTED, corrupted.code)
        val bug = assertThrows(IllegalArgumentException::class.java) {
            TransferFiles.writeArchive({ java.io.ByteArrayOutputStream() }) { throw IllegalArgumentException("bug") }
        }
        assertEquals("bug", bug.message)
        val out = java.io.ByteArrayOutputStream()
        assertEquals(
            7,
            TransferFiles.writeArchive({ out }) {
                it.write(byteArrayOf(1, 2, 3))
                7
            },
        )
        assertArrayEquals(byteArrayOf(1, 2, 3), out.toByteArray())
    }

    @Test
    fun `provider failures on read are Polish`() {
        for (failure in listOf<() -> java.io.InputStream?>(
            { throw java.io.FileNotFoundException("open failed: ENOENT") },
            { throw SecurityException("Permission Denial") },
            { null },
            {
                object : java.io.InputStream() {
                    override fun read() = throw java.io.IOException("EIO")
                }
            },
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
            {
                object : java.io.OutputStream() {
                    override fun write(b: Int) = throw java.io.IOException("ENOSPC")
                }
            },
        )) {
            val e = assertThrows(java.io.IOException::class.java) { TransferFiles.writeText("x", failure) }
            assertEquals(expected, e.message)
        }
    }
}
