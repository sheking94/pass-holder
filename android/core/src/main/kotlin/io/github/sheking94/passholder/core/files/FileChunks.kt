package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import java.security.MessageDigest
import java.util.UUID

/** Result of [FileChunks.encrypt]: the descriptor plus one Base64 blob per chunk. */
data class EncryptedFile(val attachment: Attachment, val blobs: List<String>)

/** Chunked file encryption, same as core/src/files/chunks.ts. Errors are [IllegalArgumentException]s with the TS texts. */
object FileChunks {
    const val FILE_TOO_LARGE = "File too large"
    const val EMPTY_FILE = "Empty file"
    const val INVALID_FILE_NAME = "Invalid file name"
    const val FILE_CORRUPTED = "File is corrupted"

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
        require(bytes.isNotEmpty()) { EMPTY_FILE }
        require(bytes.size <= Attachments.MAX_FILE_SIZE) { FILE_TOO_LARGE }
        require(Attachments.isName(name)) { INVALID_FILE_NAME }
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
        require(index in 0 until a.chunks) { FILE_CORRUPTED }
        return try {
            Aead.open(Encoding.fromBase64(a.key), blob, aad(a.id, index, a.chunks))
        } catch (e: Exception) {
            throw IllegalArgumentException(FILE_CORRUPTED)
        }
    }

    /** Decrypts all chunks; any mismatch in count, size, SHA-256 or AES-GCM yields [FILE_CORRUPTED]. */
    fun decrypt(a: Attachment, blobs: List<String>): ByteArray {
        require(blobs.size == a.chunks && a.chunks == Attachments.chunkCount(a.size)) { FILE_CORRUPTED }
        val parts = ArrayList<ByteArray>(blobs.size)
        var total = 0L
        for (i in blobs.indices) {
            val part = decryptChunk(a, i, blobs[i])
            total += part.size
            // Check the size before assembling so a bogus descriptor cannot force a huge allocation.
            require(total <= a.size) { FILE_CORRUPTED }
            parts.add(part)
        }
        require(total == a.size) { FILE_CORRUPTED }
        val out = ByteArray(total.toInt())
        var pos = 0
        for (p in parts) {
            p.copyInto(out, pos)
            pos += p.size
        }
        require(sha256Hex(out) == a.sha256) { FILE_CORRUPTED }
        return out
    }
}
