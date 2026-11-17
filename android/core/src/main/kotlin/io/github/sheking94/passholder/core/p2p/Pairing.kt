// Pairing code, key and messages, same as core/src/p2p/pairing.ts.
package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.Kdf
import io.github.sheking94.passholder.core.KdfParams
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

    private const val MAX_DEVICE_ID_LENGTH = 64
    private val PAIR_KEY_INFO = Encoding.utf8("passholder/v2/pair-key")

    /** 8 decimal digits. Bytes >= 250 are rejected so every digit is equally likely (no `% 10` bias). */
    fun generateCode(): String {
        val code = StringBuilder()
        while (code.length < 8) {
            for (b in Encoding.randomBytes(16)) {
                val v = b.toInt() and 0xff
                if (v < 250 && code.length < 8) code.append(v % 10)
            }
        }
        return code.toString()
    }

    /** HKDF-SHA256 of the CPace ISK without salt, 32 bytes. */
    fun key(isk: ByteArray): ByteArray {
        val out = ByteArray(32)
        HKDFBytesGenerator(SHA256Digest()).apply { init(HKDFParameters(isk, null, PAIR_KEY_INFO)) }.generateBytes(out, 0, out.size)
        return out
    }

    /** AAD binds the message to its kind and to the sender's role, so a reflected message does not open. */
    fun aad(kind: PairingKind, from: CpaceRole): String = "passholder/v2/pair/${kind.wire}/${from.wire}"

    /** [from] is the role of the caller (the sealer). */
    fun sealIdentity(key: ByteArray, from: CpaceRole, value: DeviceIdentity): String =
        seal(key, PairingKind.IDENTITY, from, P2pJson.json.encodeToString(value), null)

    fun sealVaultInfo(key: ByteArray, from: CpaceRole, value: VaultInfo): String =
        seal(key, PairingKind.VAULT_INFO, from, P2pJson.json.encodeToString(value), null)

    /** [nonce] is only for test vectors. */
    internal fun sealIdentity(key: ByteArray, from: CpaceRole, value: DeviceIdentity, nonce: ByteArray?): String =
        seal(key, PairingKind.IDENTITY, from, P2pJson.json.encodeToString(value), nonce)

    internal fun sealVaultInfo(key: ByteArray, from: CpaceRole, value: VaultInfo, nonce: ByteArray?): String =
        seal(key, PairingKind.VAULT_INFO, from, P2pJson.json.encodeToString(value), nonce)

    /** [from] is the role of the side that sealed the message (the peer of the caller). */
    fun openIdentity(key: ByteArray, from: CpaceRole, blob: String): DeviceIdentity =
        parseIdentity(openJson(key, PairingKind.IDENTITY, from, blob))

    fun openVaultInfo(key: ByteArray, from: CpaceRole, blob: String): VaultInfo =
        parseVaultInfo(openJson(key, PairingKind.VAULT_INFO, from, blob))

    private fun seal(key: ByteArray, kind: PairingKind, from: CpaceRole, json: String, nonce: ByteArray?): String {
        val plaintext = Encoding.utf8(json)
        val aad = aad(kind, from)
        return if (nonce == null) Aead.seal(key, plaintext, aad) else Aead.seal(key, plaintext, aad, nonce)
    }

    private fun openJson(key: ByteArray, kind: PairingKind, from: CpaceRole, blob: String): JsonElement =
        P2pJson.json.parseToJsonElement(Encoding.fromUtf8(Aead.open(key, blob, aad(kind, from))))

    /** Strict Base64: must decode and re-encode to the same text, with an exact decoded length when given. */
    private fun checkBase64(value: JsonElement?, field: String, length: Int? = null) {
        val text = string(value, field)
        val bytes = try {
            Encoding.fromBase64(text)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("$field is not valid Base64")
        }
        require(Encoding.toBase64(bytes) == text) { "$field is not canonical Base64" }
        require(length == null || bytes.size == length) { "$field must be $length bytes" }
        require(bytes.isNotEmpty()) { "$field must not be empty" }
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
        checkBase64(v["staticPublicKey"], "staticPublicKey", 32)
        return DeviceIdentity(deviceId, name, string(v["staticPublicKey"], "staticPublicKey"))
    }

    private fun parseVaultInfo(v: JsonElement): VaultInfo {
        require(v is JsonObject) { "Vault info must be an object" }
        checkBase64(v["epoch"], "epoch", 16)
        val kdfObject = v["kdf"]
        require(kdfObject is JsonObject) { "Invalid kdf" }
        checkBase64(kdfObject["salt"], "kdf.salt", 16)
        val kdf = KdfParams(
            alg = string(kdfObject["alg"], "kdf.alg"),
            salt = string(kdfObject["salt"], "kdf.salt"),
            memoryKiB = kdfInt(kdfObject["memoryKiB"], "kdf.memoryKiB"),
            iterations = kdfInt(kdfObject["iterations"], "kdf.iterations"),
            parallelism = kdfInt(kdfObject["parallelism"], "kdf.parallelism"),
        )
        Kdf.assertAcceptable(kdf)
        checkBase64(v["wrappedVaultKey"], "wrappedVaultKey")
        val addresses = v["addresses"]
        val list = (addresses as? JsonArray)?.map(StrictJson::string)
        require(
            list != null && list.size <= MAX_ADDRESSES &&
                list.all { it != null && it.length in 1..MAX_ADDRESS_LENGTH },
        ) { "addresses must be at most $MAX_ADDRESSES strings of 1..$MAX_ADDRESS_LENGTH chars" }
        return VaultInfo(
            epoch = string(v["epoch"], "epoch"),
            kdf = kdf,
            wrappedVaultKey = string(v["wrappedVaultKey"], "wrappedVaultKey"),
            addresses = list.map { it!! },
        )
    }

    /** A JSON integer that fits an Int; anything else is rejected before the KDF bounds are checked. */
    private fun kdfInt(value: JsonElement?, field: String): Int {
        val n = P2pJson.safeLong(value)
        require(n != null && n <= Int.MAX_VALUE) { "Invalid $field" }
        return n.toInt()
    }
}
