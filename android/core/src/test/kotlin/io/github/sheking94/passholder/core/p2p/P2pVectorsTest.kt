package io.github.sheking94.passholder.core.p2p

import kotlinx.serialization.Serializable
import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
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

@Serializable
private data class PairingKeyVector(val description: String, val isk: String, val key: String)

@Serializable
private data class PairingMessageVector(
    val description: String,
    val key: String,
    val kind: String,
    val from: String,
    val value: JsonElement,
    val aad: String,
    val nonce: String,
    val blob: String,
)

@Serializable
private data class FramesVector(
    val MAX_FRAME_PLAINTEXT: Int,
    val MAX_FRAMES: Int,
    val cipherKey: String,
    val payloadChar: String,
    val payloadStringLength: Int,
    val plaintextLength: Int,
    val chunkLengths: List<Int>,
)

@Serializable
private data class PagingVector(val MAX_CHANGES_PER_REQUEST: Int, val MAX_CHANGES_PER_RESPONSE: Int)

/** Sections of v2.json grow with each module; unknown sections are ignored until their task adds them. */
@Serializable
private data class P2pVectors(
    val hlcCompare: List<HlcCompareVector>,
    val entryPayload: List<EntryPayloadVector>,
    val pairingKey: List<PairingKeyVector>,
    val pairingMessage: List<PairingMessageVector>,
    val frames: FramesVector,
    val paging: PagingVector,
)

/** The same core/test-vectors/v2.json the TypeScript core is tested against. */
class P2pVectorsTest {
    private val lenientJson = Json { ignoreUnknownKeys = true }

    private val vectors: P2pVectors = lenientJson.decodeFromString(
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

    @TestFactory
    fun pairingKey() = vectors.pairingKey.map { v ->
        DynamicTest.dynamicTest("pairing key: ${v.description.take(60)}") {
            assertEquals(v.key, Encoding.toHex(Pairing.key(Encoding.fromHex(v.isk))))
        }
    }

    @TestFactory
    fun pairingMessage() = vectors.pairingMessage.map { v ->
        DynamicTest.dynamicTest("pairing message: ${v.description}") {
            val key = Encoding.fromHex(v.key)
            val nonce = Encoding.fromHex(v.nonce)
            val kind = PairingKind.entries.single { it.wire == v.kind }
            val from = CpaceRole.entries.single { it.wire == v.from }
            assertEquals(v.aad, Pairing.aad(kind, from))
            if (kind == PairingKind.IDENTITY) {
                val value = P2pJson.json.decodeFromJsonElement<DeviceIdentity>(v.value)
                assertEquals(v.blob, Pairing.sealIdentity(key, from, value, nonce))
                assertEquals(value, Pairing.openIdentity(key, from, v.blob))
            } else {
                val value = P2pJson.json.decodeFromJsonElement<VaultInfo>(v.value)
                assertEquals(v.blob, Pairing.sealVaultInfo(key, from, value, nonce))
                assertEquals(value, Pairing.openVaultInfo(key, from, v.blob))
            }
        }
    }

    @Test
    fun paging() {
        assertEquals(vectors.paging.MAX_CHANGES_PER_REQUEST, HostSync.MAX_CHANGES_PER_REQUEST)
        assertEquals(vectors.paging.MAX_CHANGES_PER_RESPONSE, HostSync.MAX_CHANGES_PER_RESPONSE)
    }

    @Test
    fun frames() {
        val f = vectors.frames
        assertEquals(f.MAX_FRAME_PLAINTEXT, Frames.MAX_FRAME_PLAINTEXT)
        assertEquals(f.MAX_FRAMES, Frames.MAX_FRAMES)
        val json = "\"" + f.payloadChar.repeat(f.payloadStringLength) + "\""
        assertEquals(f.plaintextLength, Encoding.utf8(json).size)
        val frames = Frames.encrypt(CipherState(Encoding.fromHex(f.cipherKey)), json)
        assertEquals(f.chunkLengths, frames.map { Encoding.fromBase64(it).size - 16 })
    }
}
