package io.github.sheking94.passholder.app

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

/** Reading a picked file and saving a downloaded one, on bytes; the save dialog intent; the export phrase. */
@RunWith(RobolectricTestRunner::class)
class AttachmentFilesTest {
    private val limit = 10_485_760

    private fun tooLarge(size: Long?, bytes: Int, opened: IntArray) =
        assertThrows(IllegalArgumentException::class.java) {
            AttachmentFiles.read("a.bin", "", size) { opened[0]++; ByteArrayInputStream(ByteArray(bytes)) }
        }

    @Test
    fun `a known size over the limit is refused without opening the stream`() {
        val opened = intArrayOf(0)
        assertEquals("Plik jest za duży (limit 10 MB)", tooLarge(10_485_761L, 1, opened).message)
        assertEquals(0, opened[0])
    }

    @Test
    fun `an unknown size over the limit is refused after reading`() {
        assertEquals("Plik jest za duży (limit 10 MB)", tooLarge(null, limit + 1, intArrayOf(0)).message)
    }

    @Test
    fun `a file of exactly the limit is read`() {
        val f = AttachmentFiles.read("a.bin", "application/x", null) { ByteArrayInputStream(ByteArray(limit) { 1 }) }
        assertEquals(limit, f.bytes.size)
    }

    @Test
    fun `an empty file is refused, by known size or by reading`() {
        val opened = intArrayOf(0)
        val bySize = assertThrows(IllegalArgumentException::class.java) {
            AttachmentFiles.read("a", "", 0L) { opened[0]++; null }
        }
        assertEquals("Plik jest pusty", bySize.message)
        assertEquals(0, opened[0])
        val byRead = assertThrows(IllegalArgumentException::class.java) {
            AttachmentFiles.read("a", "", null) { ByteArrayInputStream(ByteArray(0)) }
        }
        assertEquals("Plik jest pusty", byRead.message)
    }

    @Test
    fun `a missing name becomes plik and a missing type becomes empty`() {
        val f = AttachmentFiles.read(null, null, 3L) { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        assertEquals("plik", f.name)
        assertEquals("", f.mime)
        assertArrayEquals(byteArrayOf(1, 2, 3), f.bytes)
    }

    @Test
    fun `a name with a control character is refused`() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            AttachmentFiles.read("a\u0001b", "", null) { ByteArrayInputStream(byteArrayOf(1)) }
        }
        assertEquals("Nieprawidłowa nazwa pliku", e.message)
    }

    @Test
    fun `provider failures become the read error`() {
        listOf<() -> java.io.InputStream?>({ throw SecurityException("no") }, { throw IOException("io") }, { throw IllegalStateException("x") }, { null }).forEach { open ->
            val e = assertThrows(IOException::class.java) { AttachmentFiles.read("a", "", null, open) }
            assertEquals("Nie udało się odczytać pliku.", e.message)
        }
    }

    @Test
    fun `write puts the bytes in the stream and provider failures become the write error`() {
        val out = ByteArrayOutputStream()
        AttachmentFiles.write(byteArrayOf(4, 5)) { out }
        assertArrayEquals(byteArrayOf(4, 5), out.toByteArray())
        listOf<() -> java.io.OutputStream?>({ null }, { throw SecurityException("no") }).forEach { open ->
            val e = assertThrows(IOException::class.java) { AttachmentFiles.write(byteArrayOf(1), open) }
            assertEquals("Nie udało się zapisać pliku. Jeśli plik powstał, usuń go.", e.message)
        }
    }

    @Test
    fun `the save dialog suggests the name and falls back to any type`() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val any = CreateDocumentOf().createIntent(ctx, CreateDocumentOf.Input("a.jpg", ""))
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, any.action)
        assertEquals("application/octet-stream", any.type)
        assertEquals("a.jpg", any.getStringExtra(Intent.EXTRA_TITLE))
        assertTrue(any.categories.contains(Intent.CATEGORY_OPENABLE))
        assertEquals("image/jpeg", CreateDocumentOf().createIntent(ctx, CreateDocumentOf.Input("a.jpg", "image/jpeg")).type)
    }

    @Test
    fun `the phrase of skipped files in an export`() {
        assertEquals("1 plik nie zostanie wyeksportowany", skippedFilesPhrase(1))
        assertEquals("2 pliki nie zostaną wyeksportowane", skippedFilesPhrase(2))
        assertEquals("5 plików nie zostanie wyeksportowanych", skippedFilesPhrase(5))
        assertEquals("12 plików nie zostanie wyeksportowanych", skippedFilesPhrase(12))
        assertEquals("22 pliki nie zostaną wyeksportowane", skippedFilesPhrase(22))
    }
}
