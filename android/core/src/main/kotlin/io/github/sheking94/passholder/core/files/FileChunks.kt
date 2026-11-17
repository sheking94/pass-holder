package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.requireCode
import java.security.MessageDigest
import java.util.UUID

/** Result of [FileChunks.encrypt]: the descriptor plus one Base64 blob per chunk. */
data class EncryptedFile(val attachment: Attachment, val blobs: List<String>)

/** Chunked file encryption, same as core/src/files/chunks.ts. Errors are [PassHolderException]s with the TS codes. */
object FileChunks {
    /** AAD binding a chunk to its file, position and total count. */
    fun aad(id: String, index: Int, chunks: Int): String = "passholder/v3/file/$id/$index/$chunks"

    fun sha256Hex(bytes: ByteArray): String = Encoding.toHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun encrypt(bytes: ByteArray, name: String, mime: String): EncryptedFile {
        checkInput(bytes, name)
        val chunks = Attachments.chunkCount(bytes.size.toLong())
        return build(bytes, name, mime, UUID.randomUUID().toString(), Encoding.randomBytes(32), chunks) { null }
    }

    /**
     * ONLY for test vectors (fixed id, key and one nonce per chunk). Never use in production code:
     * reusing a nonce with the same key breaks AES-GCM.
     */
    internal fun encryptFixed(
        bytes: ByteArray,
        name: String,
        mime: String,
        id: String,
        key: ByteArray,
        nonces: List<ByteArray>,
    ): EncryptedFile {
        checkInput(bytes, name)
        val chunks = Attachments.chunkCount(bytes.size.toLong())
        require(nonces.size == chunks) { "Nonce count must equal chunk count" }
        return build(bytes, name, mime, id, key, chunks) { nonces[it] }
    }

    private fun checkInput(bytes: ByteArray, name: String) {
        requireCode(bytes.isNotEmpty(), ErrorCode.FILE_EMPTY)
        requireCode(bytes.size <= Attachments.MAX_FILE_SIZE, ErrorCode.FILE_TOO_LARGE)
        requireCode(Attachments.isName(name), ErrorCode.FILE_INVALID_NAME)
    }

    private fun build(
        bytes: ByteArray,
        name: String,
        mime: String,
        id: String,
        key: ByteArray,
        chunks: Int,
        nonce: (Int) -> ByteArray?,
    ): EncryptedFile {
        val blobs = (0 until chunks).map { i ->
            val from = i * Attachments.FILE_CHUNK_SIZE
            val part = bytes.copyOfRange(from, minOf(bytes.size, from + Attachments.FILE_CHUNK_SIZE))
            val n = nonce(i)
            if (n == null) Aead.seal(key, part, aad(id, i, chunks)) else Aead.seal(key, part, aad(id, i, chunks), n)
        }
        val attachment = Attachment(
            id = id,
            name = name,
            // An unusable MIME type is normalized to "" (application/octet-stream) instead of failing.
            mime = if (Attachments.isMime(mime)) mime else "",
            size = bytes.size.toLong(),
            chunks = chunks,
            sha256 = sha256Hex(bytes),
            key = Encoding.toBase64(key),
        )
        return EncryptedFile(attachment, blobs)
    }

    fun decryptChunk(a: Attachment, index: Int, blob: String): ByteArray {
        requireCode(index in 0 until a.chunks, ErrorCode.FILE_CORRUPTED)
        return try {
            Aead.open(Encoding.fromBase64(a.key), blob, aad(a.id, index, a.chunks))
        } catch (e: Exception) {
            throw PassHolderException(ErrorCode.FILE_CORRUPTED, cause = e)
        }
    }

    /** Decrypts all chunks; any mismatch in count, size, SHA-256 or AES-GCM yields [ErrorCode.FILE_CORRUPTED]. */
    fun decrypt(a: Attachment, blobs: List<String>): ByteArray {
        requireCode(blobs.size == a.chunks && a.chunks == Attachments.chunkCount(a.size), ErrorCode.FILE_CORRUPTED)
        val parts = ArrayList<ByteArray>(blobs.size)
        var total = 0L
        for (i in blobs.indices) {
            val part = decryptChunk(a, i, blobs[i])
            total += part.size
            // Check the size before assembling so a bogus descriptor cannot force a huge allocation.
            requireCode(total <= a.size, ErrorCode.FILE_CORRUPTED)
            parts.add(part)
        }
        requireCode(total == a.size, ErrorCode.FILE_CORRUPTED)
        val out = ByteArray(total.toInt())
        var pos = 0
        for (p in parts) {
            p.copyInto(out, pos)
            pos += p.size
        }
        requireCode(sha256Hex(out) == a.sha256, ErrorCode.FILE_CORRUPTED)
        return out
    }
}
