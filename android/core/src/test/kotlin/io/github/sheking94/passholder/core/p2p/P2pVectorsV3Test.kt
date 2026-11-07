package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import java.io.File

@Serializable
private data class V3Limits(
    val MAX_ENTRY_BLOB_LENGTH: Int,
    val MAX_BLOB_BYTES_PER_ROUND: Int,
    val MAX_CHANGES_PER_REQUEST: Int,
    val MAX_CHANGES_PER_RESPONSE: Int,
)

@Serializable
private data class V3Entry(
    val description: String,
    val vaultKey: String,
    val id: String,
    val nonce: String,
    val deleted: Boolean,
    val payload: String,
    val parsed: JsonElement,
    val blob: String,
)

@Serializable
private data class V3Rejected(val description: String, val deleted: Boolean, val payload: String, val error: String)

@Serializable
private data class V3Vectors(
    val format: String,
    val version: Int,
    val limits: V3Limits,
    val entries: List<V3Entry>,
    val rejected: List<V3Rejected>,
)

/** The same core/test-vectors/v3.json the TypeScript core is tested against. */
class P2pVectorsV3Test {
    private val vectors: V3Vectors = Json { ignoreUnknownKeys = true }.decodeFromString(
        File(System.getProperty("passholder.repoRoot"), "core/test-vectors/v3.json").readText(),
    )

    @Test
    fun headerAndLimits() {
        assertEquals("passholder-test-vectors", vectors.format)
        assertEquals(3, vectors.version)
        val l = vectors.limits
        assertEquals(l.MAX_ENTRY_BLOB_LENGTH, EntryV3.MAX_BLOB_LENGTH)
        assertEquals(l.MAX_BLOB_BYTES_PER_ROUND, HostSync.MAX_BLOB_BYTES_PER_ROUND)
        assertEquals(l.MAX_CHANGES_PER_REQUEST, HostSync.MAX_CHANGES_PER_REQUEST)
        assertEquals(l.MAX_CHANGES_PER_RESPONSE, HostSync.MAX_CHANGES_PER_RESPONSE)
    }

    @TestFactory
    fun entries() = vectors.entries.map { e ->
        DynamicTest.dynamicTest("entry: ${e.description}") {
            val key = Encoding.fromHex(e.vaultKey)
            val nonce = Encoding.fromHex(e.nonce)
            val value = Json.parseToJsonElement(e.payload)
            // The blob is the seal of the exact payload text.
            assertEquals(e.blob, EntryV3.encryptJson(key, e.id, e.payload, nonce))
            val opened = EntryV3.decrypt(key, e.id, e.blob)
            assertEquals(value, opened)
            if (e.deleted) {
                assertEquals(JsonNull, e.parsed)
                val data = EntryV3.parseTombstone(value)
                assertEquals(e.payload, EntryV3.serializeTombstone(data))
                assertEquals(data, EntryV3.parseTombstone(opened))
            } else {
                val data = EntryV3.parse(value)
                assertEquals(EntryV3.parse(e.parsed), data)
                assertEquals(e.parsed, Json.parseToJsonElement(EntryV3.serialize(data)))
                if (e.payload.startsWith("{\"v\":3")) assertEquals(e.payload, EntryV3.serialize(data))
                assertEquals(data, EntryV3.parse(opened))
            }
        }
    }

    @TestFactory
    fun rejected() = vectors.rejected.map { r ->
        DynamicTest.dynamicTest("rejected: ${r.description}") {
            val value = Json.parseToJsonElement(r.payload)
            val e = assertThrows(IllegalArgumentException::class.java) {
                if (r.deleted) EntryV3.parseTombstone(value) else EntryV3.parse(value)
            }
            assertNotNull(e.message)
            assertEquals(r.error, e.message)
        }
    }
}
