package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.StrictJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Storage of encrypted file chunks on the host. Not thread-safe: callers hold `synchronized(store)`
 * ([FileHost.process] does it itself).
 */
interface FileStore {
    /** Chunk count the file was announced with, null for an unknown id. */
    fun chunks(id: String): Int?

    /** Indexes of stored chunks, ascending. */
    fun have(id: String): List<Int>

    fun get(id: String, index: Int): String?

    /** Stores a chunk; [now] becomes the file's creation time when this is its first chunk. */
    fun put(chunk: FileChunk, now: Long)

    /** Whether [bytes] more blob characters fit. */
    fun canStore(bytes: Long): Boolean

    /** Time the first chunk of the file was stored. */
    fun createdAt(id: String): Long?

    fun ids(): List<String>

    fun delete(id: String)

    fun clear()
}

/** One encrypted chunk as the client sends it: file id, position, the file's chunk count and the blob. */
data class FileChunk(val id: String, val index: Int, val chunks: Int, val blob: String)

/** A decoded /p2p/v2/file request whose shape was checked. */
private sealed interface FileRequest {
    val epoch: String

    class Status(override val epoch: String, val ids: List<String>) : FileRequest

    class Put(override val epoch: String, val chunk: FileChunk) : FileRequest

    class Get(override val epoch: String, val id: String, val index: Int) : FileRequest
}

/** Reply of [FileHost.process]: a 200 body is to be encrypted, other statuses go out in plaintext. */
data class FileReply(val status: Int, val body: JsonObject)

/** Port of core/src/files/host-files.ts. */
object FileHost {
    private fun fail(status: Int, error: String) = FileReply(status, JsonObject(mapOf("error" to JsonPrimitive(error))))

    private val MALFORMED = fail(400, "malformed file request")

    private fun uuid(v: JsonElement?): String? = StrictJson.string(v)?.takeIf { Attachments.UUID_V4.matches(it) }

    /** Handles one decoded /p2p/v2/file request; the store is locked for the duration of the call. */
    fun process(store: FileStore, epoch: String, request: JsonElement, now: Long): FileReply {
        val req = parse(request) ?: return MALFORMED
        if (req.epoch != epoch) return epochReply(epoch)
        return synchronized(store) {
            when (req) {
                is FileRequest.Status -> status(store, req.ids)
                is FileRequest.Put -> put(store, req.chunk, now)
                is FileRequest.Get -> get(store, req.id, req.index)
            }
        }
    }

    /** The request with its shape checked, or null when it is malformed. */
    private fun parse(request: JsonElement): FileRequest? {
        if (request !is JsonObject) return null
        val epoch = StrictJson.string(request["epoch"]) ?: return null
        val maxChunks = Attachments.MAX_FILE_CHUNKS.toLong()
        return when (StrictJson.string(request["op"])) {
            "status" -> {
                val ids = request["ids"] as? JsonArray ?: return null
                if (ids.size > Attachments.MAX_STATUS_IDS) return null
                FileRequest.Status(epoch, ids.map { uuid(it) ?: return null })
            }

            "put" -> {
                val id = uuid(request["id"]) ?: return null
                val chunks = jsonInt(request["chunks"], 1, maxChunks) ?: return null
                val index = jsonInt(request["index"], 0, chunks - 1) ?: return null
                val blob = StrictJson.string(request["blob"]) ?: return null
                if (blob.length > Attachments.MAX_FILE_BLOB_LENGTH) return null
                FileRequest.Put(epoch, FileChunk(id, index.toInt(), chunks.toInt(), blob))
            }

            "get" -> {
                val id = uuid(request["id"]) ?: return null
                val index = jsonInt(request["index"], 0, maxChunks - 1) ?: return null
                FileRequest.Get(epoch, id, index.toInt())
            }

            else -> null
        }
    }

    private fun status(store: FileStore, ids: List<String>): FileReply {
        val files = ids.map { id ->
            val chunks = store.chunks(id)
            if (chunks == null) {
                statusJson(id, 0, emptyList(), false)
            } else {
                val have = store.have(id)
                statusJson(id, chunks, have, have.size == chunks)
            }
        }
        return FileReply(200, JsonObject(mapOf("files" to JsonArray(files))))
    }

    /** Stores a new chunk; the same chunk again is accepted without a write, a different one is refused. */
    private fun put(store: FileStore, chunk: FileChunk, now: Long): FileReply {
        val known = store.chunks(chunk.id)
        if (known != null && known != chunk.chunks) return fail(400, "chunk count mismatch")
        val existing = store.get(chunk.id, chunk.index)
        if (existing != null) {
            if (existing != chunk.blob) return fail(409, "chunk differs")
        } else {
            if (!store.canStore(chunk.blob.length.toLong())) return fail(507, "insufficient storage")
            store.put(chunk, now)
        }
        return FileReply(200, JsonObject(mapOf("have" to JsonPrimitive(store.have(chunk.id).size))))
    }

    private fun get(store: FileStore, id: String, index: Int): FileReply {
        val chunks = store.chunks(id)
        val blob = store.get(id, index)
        if (chunks == null || blob == null) return fail(404, "chunk not found")
        return FileReply(200, JsonObject(mapOf("chunks" to JsonPrimitive(chunks), "blob" to JsonPrimitive(blob))))
    }

    private fun epochReply(epoch: String) = FileReply(200, JsonObject(mapOf("epoch" to JsonPrimitive(epoch))))

    private fun statusJson(id: String, chunks: Int, have: List<Int>, complete: Boolean) = JsonObject(
        linkedMapOf(
            "id" to JsonPrimitive(id),
            "chunks" to JsonPrimitive(chunks),
            "have" to JsonArray(have.map { JsonPrimitive(it) }),
            "complete" to JsonPrimitive(complete),
        ),
    )

    /** Ids of stored files that no live entry uses and whose first chunk is older than ORPHAN_FILE_AGE_MS. */
    fun orphanIds(store: FileStore, used: Set<String>, now: Long): List<String> = synchronized(store) {
        store.ids().filter { id ->
            id !in used && store.createdAt(id)?.let { now - it > Attachments.ORPHAN_FILE_AGE_MS } == true
        }
    }
}
