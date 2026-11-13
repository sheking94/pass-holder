package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Descriptor of a file attached to an entry; port of core/src/files/attachment.ts. */
data class Attachment(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long,
    val chunks: Int,
    val sha256: String,
    val key: String,
)

private val JSON_NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")

/**
 * A JSON number as JS reads it: a non-string primitive with a finite integral value ("1", "1.0" and "1e0" are all 1),
 * within [min]..[max]. Anything else (text, null, 1.5, 1e400, wrong range) gives null.
 */
internal fun jsonInt(value: JsonElement?, min: Long, max: Long): Long? {
    if (value !is JsonPrimitive || value is JsonNull || value.isString) return null
    if (!JSON_NUMBER.matches(value.content)) return null
    val d = value.content.toDoubleOrNull() ?: return null
    if (!d.isFinite() || d != Math.floor(d)) return null
    if (d < min.toDouble() || d > max.toDouble()) return null
    return d.toLong()
}

object Attachments {
    const val MAX_FILE_SIZE = 10485760
    const val FILE_CHUNK_SIZE = 262144
    const val MAX_FILE_CHUNKS = 40

    /** Base64 length of one sealed chunk: 4 * ceil((29 + FILE_CHUNK_SIZE) / 3). */
    const val MAX_FILE_BLOB_LENGTH = 349564

    /** Limit enforced when adding a file in the UI. */
    const val MAX_ATTACHMENTS_PER_ENTRY = 20

    /** Limit enforced by the parser and the merge (an entry can exceed 20 after a merge). */
    const val MAX_ATTACHMENTS_PARSED = 40
    const val ORPHAN_FILE_AGE_MS = 86_400_000L
    const val MAX_STATUS_IDS = 500

    /** Lowercase UUID v4. */
    val UUID_V4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    private const val INVALID_ENTRY = "Invalid entry payload"
    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")
    private const val MAX_NAME_LENGTH = 255
    private const val MAX_MIME_LENGTH = 127
    private val KEYS = setOf("id", "name", "mime", "size", "chunks", "sha256", "key")

    private fun isControl(c: Char) = c <= '\u001f' || c in '\u007f'..'\u009f'

    fun chunkCount(size: Long): Int = ((size + FILE_CHUNK_SIZE - 1) / FILE_CHUNK_SIZE).toInt()

    fun canAdd(count: Int): Boolean = count < MAX_ATTACHMENTS_PER_ENTRY

    /** 1..255 UTF-16 units, no slashes or control characters. */
    fun isName(name: String): Boolean =
        name.length in 1..MAX_NAME_LENGTH && name.none { it == '/' || it == '\\' || isControl(it) }

    /** At most 127 UTF-16 units, no control characters. */
    fun isMime(mime: String): Boolean = mime.length <= MAX_MIME_LENGTH && mime.none(::isControl)

    /** The descriptor as a JSON object with the canonical key order. */
    fun json(a: Attachment): JsonObject = JsonObject(
        linkedMapOf(
            "id" to JsonPrimitive(a.id),
            "name" to JsonPrimitive(a.name),
            "mime" to JsonPrimitive(a.mime),
            "size" to JsonPrimitive(a.size),
            "chunks" to JsonPrimitive(a.chunks),
            "sha256" to JsonPrimitive(a.sha256),
            "key" to JsonPrimitive(a.key),
        ),
    )

    private fun fail(): Nothing = throw IllegalArgumentException(INVALID_ENTRY)

    private fun str(value: JsonElement?): String {
        if (value !is JsonPrimitive || value is JsonNull || !value.isString) fail()
        return value.content
    }

    private fun canonicalKey(key: String): Boolean = try {
        val bytes = Encoding.fromBase64(key)
        bytes.size == 32 && Encoding.toBase64(bytes) == key
    } catch (_: IllegalArgumentException) {
        false
    }

    private fun parseOne(value: JsonElement): Attachment {
        if (value !is JsonObject || value.keys != KEYS) fail()
        val id = str(value["id"])
        if (!UUID_V4.matches(id)) fail()
        val name = str(value["name"])
        if (!isName(name)) fail()
        val mime = str(value["mime"])
        if (!isMime(mime)) fail()
        val size = jsonInt(value["size"], 1, MAX_FILE_SIZE.toLong()) ?: fail()
        val chunks = jsonInt(value["chunks"], 1, MAX_FILE_CHUNKS.toLong()) ?: fail()
        if (chunks != chunkCount(size).toLong()) fail()
        val sha256 = str(value["sha256"])
        if (!SHA256_HEX.matches(sha256)) fail()
        val key = str(value["key"])
        if (!canonicalKey(key)) fail()
        return Attachment(id, name, mime, size, chunks.toInt(), sha256, key)
    }

    /** A non-empty list of up to [MAX_ATTACHMENTS_PARSED] descriptors with unique ids; throws "Invalid entry payload". */
    fun parseList(value: JsonElement?): List<Attachment> {
        if (value !is JsonArray || value.size < 1 || value.size > MAX_ATTACHMENTS_PARSED) fail()
        val list = value.map(::parseOne)
        if (list.map { it.id }.toSet().size != list.size) fail()
        return list
    }

    /** The winner's list, then the loser's descriptors whose id the winner lacks, in the loser's order. */
    fun merge(winner: List<Attachment>, loser: List<Attachment>): List<Attachment> {
        val ids = winner.mapTo(HashSet()) { it.id }
        return winner + loser.filter { ids.add(it.id) }
    }
}
