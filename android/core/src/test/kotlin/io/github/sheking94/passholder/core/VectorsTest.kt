package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.Assertions.assertEquals
import java.io.File

@Serializable
private data class KdfVector(
    val description: String, val password: String, val passwordUtf8Nfc: String, val kdf: KdfParams,
    val masterKey: String, val encKey: String, val authKey: String, val authHash: String,
)

@Serializable
private data class SealVector(val description: String, val key: String, val plaintextHex: String, val aad: String, val nonce: String, val blob: String)

@Serializable
private data class Vectors(val kdf: List<KdfVector>, val seal: List<SealVector>)

/** The same core/test-vectors/v1.json the TypeScript core is tested against: both must agree bit for bit. */
class VectorsTest {
    private val vectors: Vectors = Json { ignoreUnknownKeys = true }.decodeFromString(
        File(System.getProperty("passholder.repoRoot"), "core/test-vectors/v1.json").readText(),
    )
    private val hex = Encoding::toHex

    @TestFactory
    fun kdf() = vectors.kdf.map { v ->
        DynamicTest.dynamicTest("KDF: ${v.description}") {
            assertEquals(v.passwordUtf8Nfc, hex(Encoding.utf8(v.password)))
            val masterKey = Kdf.deriveMasterKey(v.password, v.kdf)
            val keys = Kdf.splitMasterKey(masterKey)
            assertEquals(v.masterKey, hex(masterKey))
            assertEquals(v.encKey, hex(keys.encKey))
            assertEquals(v.authKey, hex(keys.authKey))
            assertEquals(v.authHash, hex(Kdf.authHash(keys.authKey)))
        }
    }

    @TestFactory
    fun seal() = vectors.seal.map { v ->
        DynamicTest.dynamicTest("AES-GCM: ${v.description.take(40)}") {
            val key = Encoding.fromHex(v.key)
            assertEquals(v.blob, Aead.seal(key, Encoding.fromHex(v.plaintextHex), v.aad, Encoding.fromHex(v.nonce)))
            assertEquals(v.plaintextHex, hex(Aead.open(key, v.blob, v.aad)))
        }
    }

    @Test
    fun `entry JSON matches the TypeScript bytes and decrypts to the same entry`() {
        val (_, live, tombstone) = vectors.seal
        val id = live.aad.removePrefix("passholder/v1/entry/")
        val vaultKey = Encoding.fromHex(live.key)

        val payload = EntryPayload("example.com", "jan@example.com", "p@ss wörd!", 1793404800000)
        assertEquals(live.plaintextHex, hex(Encoding.utf8(VaultCrypto.json.encodeToString(payload))))
        assertEquals(tombstone.plaintextHex, hex(Encoding.utf8(VaultCrypto.json.encodeToString(TombstonePayload(1793404900000)))))

        val entry = VaultCrypto.decryptRecord(vaultKey, RemoteRecord(id, 7, deleted = false, blob = live.blob))
        assertEquals(LocalEntry(id, 7, false, 1793404800000, Credentials("example.com", "jan@example.com", "p@ss wörd!")), entry)
        val gone = VaultCrypto.decryptRecord(vaultKey, RemoteRecord(id, 8, deleted = true, blob = tombstone.blob))
        assertEquals(LocalEntry(id, 8, false, 1793404900000, null), gone)
    }

    @Test
    fun `unwraps the vault key from the vector`() {
        val wrapped = vectors.seal[0]
        assertEquals(wrapped.plaintextHex, hex(VaultCrypto.unwrapVaultKey(Encoding.fromHex(wrapped.key), wrapped.blob)))
    }
}
