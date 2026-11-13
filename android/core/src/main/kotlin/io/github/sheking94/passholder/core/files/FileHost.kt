package io.github.sheking94.passholder.core.files

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

    fun put(id: String, index: Int, chunks: Int, blob: String, now: Long)

    /** Whether [bytes] more blob characters fit. */
    fun canStore(bytes: Long): Boolean

    /** Time the first chunk of the file was stored. */
    fun createdAt(id: String): Long?

    fun ids(): List<String>

    fun delete(id: String)

    fun clear()
}

/** In-memory [FileStore]; capacity counts the summed length of stored blobs. */
class MemoryFileStore(private val capacity: Long = Long.MAX_VALUE) : FileStore {
    private class Stored(val chunks: Int, val createdAt: Long, val blobs: MutableMap<Int, String> = HashMap())

    private val files = LinkedHashMap<String, Stored>()
    private var used = 0L

    override fun chunks(id: String) = files[id]?.chunks

    override fun have(id: String): List<Int> = files[id]?.blobs?.keys?.sorted() ?: emptyList()

    override fun get(id: String, index: Int) = files[id]?.blobs?.get(index)

    override fun put(id: String, index: Int, chunks: Int, blob: String, now: Long) {
        val file = files.getOrPut(id) { Stored(chunks, now) }
        used += blob.length - (file.blobs[index]?.length ?: 0)
        file.blobs[index] = blob
    }

    override fun canStore(bytes: Long) = bytes <= capacity - used

    override fun createdAt(id: String) = files[id]?.createdAt

    override fun ids(): List<String> = files.keys.toList()

    override fun delete(id: String) {
        val file = files.remove(id) ?: return
        used -= file.blobs.values.sumOf { it.length.toLong() }
    }

    override fun clear() {
        files.clear()
        used = 0
    }
}

/** Reply of [FileHost.process]: a 200 body is to be encrypted, other statuses go out in plaintext. */
data class FileReply(val status: Int, val body: JsonObject)

/** Port of core/src/files/host-files.ts. */
object FileHost {
    private fun fail(status: Int, error: String) = FileReply(status, JsonObject(mapOf("error" to JsonPrimitive(error))))

    private val MALFORMED = fail(400, "malformed file request")

    private fun isUuid(v: JsonElement?): Boolean =
        v is JsonPrimitive && v.isString && Attachments.UUID_V4.matches(v.content)

    private fun string(v: JsonElement?): String? = (v as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** Handles one decoded /p2p/v2/file request; the store is locked for the duration of the call. */
    fun process(store: FileStore, epoch: String, request: JsonElement, now: Long): FileReply {
        if (request !is JsonObject) return MALFORMED
        val reqEpoch = string(request["epoch"]) ?: return MALFORMED
        val max = Attachments.MAX_FILE_CHUNKS.toLong()
        return when (string(request["op"])) {
            "status" -> {
                val ids = request["ids"] as? JsonArray ?: return MALFORMED
                if (ids.size > Attachments.MAX_STATUS_IDS || !ids.all(::isUuid)) return MALFORMED
                if (reqEpoch != epoch) return epochReply(epoch)
                synchronized(store) {
                    val files = ids.map { e ->
                        val id = (e as JsonPrimitive).content
                        val chunks = store.chunks(id)
                        if (chunks == null) {
                            status(id, 0, emptyList(), false)
                        } else {
                            val have = store.have(id)
                            status(id, chunks, have, have.size == chunks)
                        }
                    }
                    FileReply(200, JsonObject(mapOf("files" to JsonArray(files))))
                }
            }
            "put" -> {
                if (!isUuid(request["id"])) return MALFORMED
                val chunks = jsonInt(request["chunks"], 1, max) ?: return MALFORMED
                val index = jsonInt(request["index"], 0, chunks - 1) ?: return MALFORMED
                val blob = string(request["blob"]) ?: return MALFORMED
                if (blob.length > Attachments.MAX_FILE_BLOB_LENGTH) return MALFORMED
                if (reqEpoch != epoch) return epochReply(epoch)
                val id = string(request["id"])!!
                synchronized(store) {
                    val known = store.chunks(id)
                    if (known != null && known != chunks.toInt()) return fail(400, "chunk count mismatch")
                    val existing = store.get(id, index.toInt())
                    if (existing != null) {
                        if (existing != blob) return fail(409, "chunk differs")
                    } else {
                        if (!store.canStore(blob.length.toLong())) return fail(507, "insufficient storage")
                        store.put(id, index.toInt(), chunks.toInt(), blob, now)
                    }
                    FileReply(200, JsonObject(mapOf("have" to JsonPrimitive(store.have(id).size))))
                }
            }
            "get" -> {
                if (!isUuid(request["id"])) return MALFORMED
                val index = jsonInt(request["index"], 0, max - 1) ?: return MALFORMED
                if (reqEpoch != epoch) return epochReply(epoch)
                val id = string(request["id"])!!
                synchronized(store) {
                    val chunks = store.chunks(id)
                    val blob = store.get(id, index.toInt())
                    if (chunks == null || blob == null) return fail(404, "chunk not found")
                    FileReply(200, JsonObject(mapOf("chunks" to JsonPrimitive(chunks), "blob" to JsonPrimitive(blob))))
                }
            }
            else -> MALFORMED
        }
    }

    private fun epochReply(epoch: String) = FileReply(200, JsonObject(mapOf("epoch" to JsonPrimitive(epoch))))

    private fun status(id: String, chunks: Int, have: List<Int>, complete: Boolean) = JsonObject(
        linkedMapOf(
            "id" to JsonPrimitive(id),
            "chunks" to JsonPrimitive(chunks),
            "have" to JsonArray(have.map { JsonPrimitive(it) }),
            "complete" to JsonPrimitive(complete),
        ),
    )

    /** Ids of stored files that no live entry uses and whose first chunk is older than ORPHAN_FILE_AGE_MS. */
    fun orphanIds(store: FileStore, used: Set<String>, now: Long): List<String> =
        synchronized(store) {
            store.ids().filter { id ->
                id !in used && store.createdAt(id)?.let { now - it > Attachments.ORPHAN_FILE_AGE_MS } == true
            }
        }
}
