package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import java.io.File

@Serializable
private data class KdfVector(
    val description: String,
    val password: String,
    val passwordUtf8Nfc: String,
    val kdf: KdfParams,
    val masterKey: String,
    val encKey: String,
)

@Serializable
private data class SealVector(
    val description: String,
    val key: String,
    val plaintextHex: String,
    val aad: String,
    val nonce: String,
    val blob: String,
)

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
    fun `unwraps the vault key from the vector`() {
        val wrapped = vectors.seal[0]
        assertEquals(wrapped.plaintextHex, hex(VaultCrypto.unwrapVaultKey(Encoding.fromHex(wrapped.key), wrapped.blob)))
    }
}
