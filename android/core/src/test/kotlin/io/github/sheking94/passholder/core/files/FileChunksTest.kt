package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.assertCode
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class FileChunksTest {
    private val chunk = Attachments.FILE_CHUNK_SIZE
    private fun sample(n: Int) = ByteArray(n) { i -> ((i * 31 + 7) and 0xff).toByte() }
    private fun fails(code: ErrorCode, block: () -> Unit) = assertCode(code, block)

    @Test
    fun buildsAad() = assertEquals("passholder/v3/file/x/1/3", FileChunks.aad("x", 1, 3))

    @Test
    fun splitsIntoChunksAndRoundTrips() {
        val bytes = sample(chunk * 2 + 5)
        val (a, blobs) = FileChunks.encrypt(bytes, "a.bin", "application/octet-stream")
        assertEquals(3, blobs.size)
        assertEquals(3, a.chunks)
        assertEquals(bytes.size.toLong(), a.size)
        assertEquals(FileChunks.sha256Hex(bytes), a.sha256)
        assertEquals(5, FileChunks.decryptChunk(a, 2, blobs[2]).size)
        assertArrayEquals(bytes, FileChunks.decrypt(a, blobs))
        assertEquals(true, Attachments.UUID_V4.matches(a.id))
    }

    @Test
    fun exactChunkSizeIsOneChunk() {
        val (a, blobs) = FileChunks.encrypt(sample(chunk), "a", "")
        assertEquals(1, blobs.size)
        assertEquals(1, a.chunks)
    }

    @Test
    fun rejectsEmptyTooLargeAndBadName() {
        fails(ErrorCode.FILE_EMPTY) { FileChunks.encrypt(ByteArray(0), "a", "") }
        fails(ErrorCode.FILE_TOO_LARGE) { FileChunks.encrypt(ByteArray(Attachments.MAX_FILE_SIZE + 1), "a", "") }
        fails(ErrorCode.FILE_INVALID_NAME) { FileChunks.encrypt(sample(3), "a/b", "") }
    }

    @Test
    fun normalizesInvalidMime() {
        assertEquals("", FileChunks.encrypt(sample(3), "a", "text/a\nb").attachment.mime)
        assertEquals("", FileChunks.encrypt(sample(3), "a", "a".repeat(128)).attachment.mime)
        assertEquals("a".repeat(127), FileChunks.encrypt(sample(3), "a", "a".repeat(127)).attachment.mime)
    }

    @Test
    fun detectsTampering() {
        val bytes = sample(chunk * 2 + 5)
        val (a, blobs) = FileChunks.encrypt(bytes, "a.bin", "")
        val other = FileChunks.encryptFixed(
            bytes,
            "a.bin",
            "",
            "123e4567-e89b-42d3-a456-426614174000",
            Encoding.fromBase64(a.key),
            (1..3).map { ByteArray(12) { _ -> it.toByte() } },
        )
        val bad = ErrorCode.FILE_CORRUPTED
        fails(bad) { FileChunks.decrypt(a, listOf(blobs[1], blobs[0], blobs[2])) }
        fails(bad) { FileChunks.decrypt(a, blobs.take(2)) }
        fails(bad) { FileChunks.decrypt(a, listOf(blobs[0], blobs[1], other.blobs[2])) }
        fails(bad) { FileChunks.decrypt(a.copy(sha256 = "0".repeat(64)), blobs) }
        fails(bad) { FileChunks.decrypt(a.copy(size = a.size - 1), blobs) }
        fails(bad) { FileChunks.decryptChunk(a.copy(chunks = 4), 0, blobs[0]) }
        fails(bad) { FileChunks.decryptChunk(a, 3, blobs[0]) }
        fails(bad) { FileChunks.decryptChunk(a, 0, "not base64!") }
    }
}
