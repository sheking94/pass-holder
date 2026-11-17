// Pairing code, key and messages, same as core/src/p2p/pairing.ts.
package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.GCM_NONCE_BYTES
import io.github.sheking94.passholder.core.KEY_BYTES
import io.github.sheking94.passholder.core.Kdf
import io.github.sheking94.passholder.core.KdfParams
import io.github.sheking94.passholder.core.RANDOM_ID_BYTES
import io.github.sheking94.passholder.core.SALT_BYTES
import io.github.sheking94.passholder.core.StrictJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters

@Serializable
data class DeviceIdentity(
    val deviceId: String,
    val name: String,
    /** Base64, 32-byte X25519 public key. */
    val staticPublicKey: String,
)

@Serializable
data class VaultInfo(
    /** Base64, 16 bytes. */
    val epoch: String,
    val kdf: KdfParams,
    val wrappedVaultKey: String,
    val addresses: List<String>,
)

enum class PairingKind(val wire: String) { IDENTITY("identity"), VAULT_INFO("vault-info") }

object Pairing {
    const val MAX_DEVICE_NAME_LENGTH = 64
    const val MAX_ADDRESSES = 16
    const val MAX_ADDRESS_LENGTH = 256

    const val CODE_LENGTH = 8

    private val PAIR_KEY_INFO = Encoding.utf8("passholder/v2/pair-key")

    /** [CODE_LENGTH] decimal digits. Bytes >= 250 are rejected so every digit is equally likely (no `% 10` bias). */
    fun generateCode(): String {
        val code = StringBuilder()
        while (code.length < CODE_LENGTH) {
            for (b in Encoding.randomBytes(16)) {
                val v = b.toInt() and 0xff
                if (v < 250 && code.length < CODE_LENGTH) code.append(v % 10)
            }
        }
        return code.toString()
    }

    /** HKDF-SHA256 of the CPace ISK without salt, 32 bytes. */
    fun key(isk: ByteArray): ByteArray {
        val out = ByteArray(KEY_BYTES)
        HKDFBytesGenerator(SHA256Digest()).apply { init(HKDFParameters(isk, null, PAIR_KEY_INFO)) }.generateBytes(out, 0, out.size)
        return out
    }

    /** AAD binds the message to its kind and to the sender's role, so a reflected message does not open. */
    fun aad(kind: PairingKind, from: CpaceRole): String = "passholder/v2/pair/${kind.wire}/${from.wire}"

    /** [from] is the role of the caller (the sealer). */
    fun sealIdentity(key: ByteArray, from: CpaceRole, value: DeviceIdentity): String =
        sealIdentity(key, from, value, Encoding.randomBytes(GCM_NONCE_BYTES))

    fun sealVaultInfo(key: ByteArray, from: CpaceRole, value: VaultInfo): String =
        sealVaultInfo(key, from, value, Encoding.randomBytes(GCM_NONCE_BYTES))

    /** [sealIdentity] with a fixed [nonce], ONLY for test vectors. */
    internal fun sealIdentity(key: ByteArray, from: CpaceRole, value: DeviceIdentity, nonce: ByteArray): String =
        seal(key, PairingKind.IDENTITY, from, P2pJson.json.encodeToString(value), nonce)

    /** [sealVaultInfo] with a fixed [nonce], ONLY for test vectors. */
    internal fun sealVaultInfo(key: ByteArray, from: CpaceRole, value: VaultInfo, nonce: ByteArray): String =
        seal(key, PairingKind.VAULT_INFO, from, P2pJson.json.encodeToString(value), nonce)

    /** [from] is the role of the side that sealed the message (the peer of the caller). */
    fun openIdentity(key: ByteArray, from: CpaceRole, blob: String): DeviceIdentity =
        parseIdentity(openJson(key, PairingKind.IDENTITY, from, blob))

    fun openVaultInfo(key: ByteArray, from: CpaceRole, blob: String): VaultInfo =
        parseVaultInfo(openJson(key, PairingKind.VAULT_INFO, from, blob))

    private fun seal(key: ByteArray, kind: PairingKind, from: CpaceRole, json: String, nonce: ByteArray): String =
        Aead.seal(key, Encoding.utf8(json), aad(kind, from), nonce)

    private fun openJson(key: ByteArray, kind: PairingKind, from: CpaceRole, blob: String): JsonElement =
        P2pJson.json.parseToJsonElement(Encoding.fromUtf8(Aead.open(key, blob, aad(kind, from))))

    /**
     * Strict Base64: must decode and re-encode to the same text, with an exact decoded length when given.
     * Returns the checked text.
     */
    private fun checkBase64(value: JsonElement?, field: String, length: Int? = null): String {
        val text = string(value, field)
        val bytes = try {
            Encoding.fromBase64(text)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("$field is not valid Base64")
        }
        require(Encoding.toBase64(bytes) == text) { "$field is not canonical Base64" }
        require(length == null || bytes.size == length) { "$field must be $length bytes" }
        require(bytes.isNotEmpty()) { "$field must not be empty" }
        return text
    }

    private fun string(value: JsonElement?, field: String): String {
        val text = StrictJson.string(value)
        require(text != null) { "$field must be a string" }
        return text
    }

    private fun boundedString(value: JsonElement?, field: String, max: Int): String {
        val text = StrictJson.string(value)
        require(text != null && text.length in 1..max) { "Invalid $field" }
        return text
    }

    private fun parseIdentity(v: JsonElement): DeviceIdentity {
        require(v is JsonObject) { "Identity must be an object" }
        val deviceId = boundedString(v["deviceId"], "deviceId", MAX_DEVICE_ID_LENGTH)
        val name = boundedString(v["name"], "name", MAX_DEVICE_NAME_LENGTH)
        return DeviceIdentity(deviceId, name, checkBase64(v["staticPublicKey"], "staticPublicKey", KEY_BYTES))
    }

    private fun parseVaultInfo(v: JsonElement): VaultInfo {
        require(v is JsonObject) { "Vault info must be an object" }
        val epoch = checkBase64(v["epoch"], "epoch", RANDOM_ID_BYTES)
        val kdfObject = v["kdf"]
        require(kdfObject is JsonObject) { "Invalid kdf" }
        val salt = checkBase64(kdfObject["salt"], "kdf.salt", SALT_BYTES)
        val kdf = KdfParams(
            alg = string(kdfObject["alg"], "kdf.alg"),
            salt = salt,
            memoryKiB = kdfInt(kdfObject["memoryKiB"], "kdf.memoryKiB"),
            iterations = kdfInt(kdfObject["iterations"], "kdf.iterations"),
            parallelism = kdfInt(kdfObject["parallelism"], "kdf.parallelism"),
        )
        Kdf.assertAcceptable(kdf)
        val wrappedVaultKey = checkBase64(v["wrappedVaultKey"], "wrappedVaultKey")
        val addresses = parseAddresses(v["addresses"])
        return VaultInfo(epoch = epoch, kdf = kdf, wrappedVaultKey = wrappedVaultKey, addresses = addresses)
    }

    private fun parseAddresses(value: JsonElement?): List<String> {
        val error = "addresses must be at most $MAX_ADDRESSES strings of 1..$MAX_ADDRESS_LENGTH chars"
        require(value is JsonArray && value.size <= MAX_ADDRESSES) { error }
        return value.map { a ->
            val text = StrictJson.string(a)
            require(text != null && text.length in 1..MAX_ADDRESS_LENGTH) { error }
            text
        }
    }

    /** A JSON integer that fits an Int; anything else is rejected before the KDF bounds are checked. */
    private fun kdfInt(value: JsonElement?, field: String): Int {
        val n = P2pJson.safeLong(value)
        require(n != null && n <= Int.MAX_VALUE) { "Invalid $field" }
        return n.toInt()
    }
}
