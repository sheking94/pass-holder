package io.github.sheking94.passholder.core.p2p

import kotlinx.serialization.Serializable
import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.math.sign

@Serializable
private data class HlcCompareVector(val description: String, val a: Hlc, val b: Hlc, val expected: Int)

@Serializable
private data class EntryPayloadVector(
    val description: String,
    val vaultKey: String,
    val id: String,
    val aad: String,
    val data: JsonElement,
    val nonce: String,
    val blob: String,
)

/** Sections of v2.json grow with each module; unknown sections are ignored until their task adds them. */
@Serializable
private data class P2pVectors(val hlcCompare: List<HlcCompareVector>, val entryPayload: List<EntryPayloadVector>)

/** The same core/test-vectors/v2.json the TypeScript core is tested against. */
class P2pVectorsTest {
    private val vectors: P2pVectors = Json { ignoreUnknownKeys = true }.decodeFromString(
        File(System.getProperty("passholder.repoRoot"), "core/test-vectors/v2.json").readText(),
    )

    @TestFactory
    fun hlcCompare() = vectors.hlcCompare.map { v ->
        DynamicTest.dynamicTest("HLC: ${v.description.take(60)}") {
            assertEquals(v.expected, v.a.compareTo(v.b).sign)
        }
    }

    @TestFactory
    fun entryPayload() = vectors.entryPayload.map { v ->
        DynamicTest.dynamicTest("entry payload: ${v.description}") {
            val key = Encoding.fromHex(v.vaultKey)
            val nonce = Encoding.fromHex(v.nonce)
            assertEquals(v.aad, EntryV2.aad(v.id))
            val isEntry = (v.data as kotlinx.serialization.json.JsonObject).containsKey("name")
            val blob = if (isEntry) {
                EntryV2.encrypt(key, v.id, EntryV2.parseEntry(v.data), nonce)
            } else {
                EntryV2.encryptTombstone(key, v.id, EntryV2.parseTombstone(v.data), nonce)
            }
            assertEquals(v.blob, blob)
            val opened = EntryV2.decrypt(key, v.id, v.blob)
            assertEquals(v.data, opened)
            if (isEntry) EntryV2.parseEntry(opened) else EntryV2.parseTombstone(opened)
        }
    }
}
