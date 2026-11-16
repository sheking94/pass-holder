package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Argon2id parameters. Stored in plain text next to the vault so another device can derive the same keys. */
@Serializable
data class KdfParams(
    val alg: String,
    /** Base64, 16 bytes. */
    val salt: String,
    /** Memory in KiB. */
    val memoryKiB: Int,
    val iterations: Int,
    val parallelism: Int,
)

class DerivedKeys(
    /** Wraps and unwraps the vault key. Never leaves the device. */
    val encKey: ByteArray,
)

/** Key derivation from docs/SPEC.md §2, same as core/src/kdf.ts. */
object Kdf {
    const val DEFAULT_MEMORY_KIB = 65536
    const val DEFAULT_ITERATIONS = 3
    const val DEFAULT_PARALLELISM = 4

    /** Lower bounds a device accepts from another one, so a malicious peer cannot downgrade the KDF. */
    const val MIN_MEMORY_KIB = 19456
    const val MIN_ITERATIONS = 2
    const val MIN_PARALLELISM = 1

    /** Upper bounds so a malicious peer cannot make the phone run out of memory (1 GiB) or hash for minutes. Same as core/src/kdf.ts. */
    const val MAX_MEMORY_KIB = 1_048_576
    const val MAX_ITERATIONS = 100
    const val MAX_PARALLELISM = 64

    private val INFO_ENC = Encoding.utf8("passholder/v1/enc")

    fun newParams(): KdfParams = KdfParams(
        alg = "argon2id",
        salt = Encoding.toBase64(Encoding.randomBytes(16)),
        memoryKiB = DEFAULT_MEMORY_KIB,
        iterations = DEFAULT_ITERATIONS,
        parallelism = DEFAULT_PARALLELISM,
    )

    fun assertAcceptable(params: KdfParams) {
        require(params.alg == "argon2id") { "Unsupported KDF: ${params.alg}" }
        require(Encoding.fromBase64(params.salt).size == 16) { "KDF salt must be 16 bytes" }
        require(params.memoryKiB >= MIN_MEMORY_KIB) { "KDF memory too low" }
        require(params.memoryKiB <= MAX_MEMORY_KIB) { "KDF memory too high for this device" }
        require(params.iterations >= MIN_ITERATIONS) { "KDF iterations too low" }
        require(params.iterations <= MAX_ITERATIONS) { "KDF iterations too high" }
        require(params.parallelism >= MIN_PARALLELISM) { "KDF parallelism too low" }
        require(params.parallelism <= MAX_PARALLELISM) { "KDF parallelism too high" }
    }

    /** Argon2id (version 0x13) of the NFC-normalized password. Slow on purpose: call it off the main thread. */
    fun deriveMasterKey(masterPassword: String, params: KdfParams): ByteArray {
        val argon = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(Encoding.fromBase64(params.salt))
            .withMemoryAsKB(params.memoryKiB)
            .withIterations(params.iterations)
            .withParallelism(params.parallelism)
            .build()
        val out = ByteArray(32)
        val password = Encoding.utf8(masterPassword)
        try {
            Argon2BytesGenerator().apply { init(argon) }.generateBytes(password, out)
        } finally {
            password.fill(0)
        }
        return out
    }

    fun splitMasterKey(masterKey: ByteArray) = DerivedKeys(
        encKey = hkdfSha256(masterKey, INFO_ENC),
    )

    fun deriveKeys(masterPassword: String, params: KdfParams): DerivedKeys {
        val masterKey = deriveMasterKey(masterPassword, params)
        try {
            return splitMasterKey(masterKey)
        } finally {
            masterKey.fill(0)
        }
    }

    /**
     * HKDF-SHA256 (RFC 5869) with an empty salt and 32 bytes of output. 32 bytes is exactly one HMAC block,
     * so the expand step is a single HMAC(prk, info || 0x01).
     */
    internal fun hkdfSha256(ikm: ByteArray, info: ByteArray): ByteArray {
        val extract = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(ByteArray(32), "HmacSHA256")) }
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }
        expand.update(info)
        expand.update(1)
        return expand.doFinal().also { prk.fill(0) }
    }
}
