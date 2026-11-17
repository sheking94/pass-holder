package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.GCM_NONCE_BYTES
import io.github.sheking94.passholder.core.KEY_BYTES
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.requireCode
import java.util.UUID

/** Result of [FileChunks.encrypt]: the descriptor plus one Base64 blob per chunk. */
data class EncryptedFile(val attachment: Attachment, val blobs: List<String>)

/** Id, key and one nonce per chunk of a file being encrypted (same as FileSecrets in core/src/files/chunks.ts). */
internal class FileSecrets(val id: String, val key: ByteArray, val nonces: List<ByteArray>)

/** Chunked file encryption, same as core/src/files/chunks.ts. Errors are [PassHolderException]s with the TS codes. */
object FileChunks {
    /** AAD binding a chunk to its file, position and total count. */
    fun aad(id: String, index: Int, chunks: Int): String = "passholder/v3/file/$id/$index/$chunks"

    fun encrypt(bytes: ByteArray, name: String, mime: String): EncryptedFile {
        checkInput(bytes, name)
        val nonces = List(Attachments.chunkCount(bytes.size.toLong())) { Encoding.randomBytes(GCM_NONCE_BYTES) }
        return build(bytes, name, mime, FileSecrets(UUID.randomUUID().toString(), Encoding.randomBytes(KEY_BYTES), nonces))
    }

    /**
     * [encrypt] with fixed secrets, ONLY for test vectors. Never use in production code:
     * reusing a nonce with the same key breaks AES-GCM.
     */
    internal fun encryptFixed(bytes: ByteArray, name: String, mime: String, secrets: FileSecrets): EncryptedFile {
        checkInput(bytes, name)
        require(secrets.nonces.size == Attachments.chunkCount(bytes.size.toLong())) { "Nonce count must equal chunk count" }
        return build(bytes, name, mime, secrets)
    }

    private fun checkInput(bytes: ByteArray, name: String) {
        requireCode(bytes.isNotEmpty(), ErrorCode.FILE_EMPTY)
        requireCode(bytes.size <= Attachments.MAX_FILE_SIZE, ErrorCode.FILE_TOO_LARGE)
        requireCode(Attachments.isName(name), ErrorCode.FILE_INVALID_NAME)
    }

    /** One chunk per nonce; the caller checked the input and the nonce count. */
    private fun build(bytes: ByteArray, name: String, mime: String, secrets: FileSecrets): EncryptedFile {
        val chunks = secrets.nonces.size
        val blobs = (0 until chunks).map { i ->
            val from = i * Attachments.FILE_CHUNK_SIZE
            val part = bytes.copyOfRange(from, minOf(bytes.size, from + Attachments.FILE_CHUNK_SIZE))
            Aead.seal(secrets.key, part, aad(secrets.id, i, chunks), secrets.nonces[i])
        }
        val attachment = Attachment(
            id = secrets.id,
            name = name,
            // An unusable MIME type is normalized to "" (application/octet-stream) instead of failing.
            mime = if (Attachments.isMime(mime)) mime else "",
            size = bytes.size.toLong(),
            chunks = chunks,
            sha256 = Encoding.sha256Hex(bytes),
            key = Encoding.toBase64(secrets.key),
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
        requireCode(Encoding.sha256Hex(out) == a.sha256, ErrorCode.FILE_CORRUPTED)
        return out
    }
}
