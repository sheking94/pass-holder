package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable
data class EntryDataV2(val name: String, val username: String, val password: String, val hlc: Hlc)

@Serializable
data class TombstoneDataV2(val hlc: Hlc)

/** Encrypted v2 entry and tombstone payloads, bound to the entry id through the AAD. */
object EntryV2 {
    fun aad(id: String): String = "passholder/v2/entry/$id"

    /** [nonce] is only for test vectors. */
    fun encrypt(vaultKey: ByteArray, id: String, data: EntryDataV2, nonce: ByteArray? = null): String =
        seal(vaultKey, id, P2pJson.json.encodeToString(data), nonce)

    fun encryptTombstone(vaultKey: ByteArray, id: String, data: TombstoneDataV2, nonce: ByteArray? = null): String =
        seal(vaultKey, id, P2pJson.json.encodeToString(data), nonce)

    /** Throws [javax.crypto.AEADBadTagException] for a wrong key, id or changed blob. */
    fun decrypt(vaultKey: ByteArray, id: String, blob: String): JsonElement =
        P2pJson.json.parseToJsonElement(Encoding.fromUtf8(Aead.open(vaultKey, blob, aad(id))))

    fun parseEntry(value: JsonElement): EntryDataV2 {
        fun str(key: String): String? = (value as? JsonObject)?.get(key)?.let { if (it is JsonPrimitive && it.isString) it.content else null }
        val name = str("name")
        val username = str("username")
        val password = str("password")
        if (name == null || username == null || password == null) throw IllegalArgumentException("Invalid entry payload")
        return EntryDataV2(name, username, password, parseHlc((value as JsonObject)["hlc"]))
    }

    fun parseTombstone(value: JsonElement): TombstoneDataV2 {
        if (value !is JsonObject) throw IllegalArgumentException("Invalid tombstone payload")
        return TombstoneDataV2(parseHlc(value["hlc"]))
    }

    private fun seal(vaultKey: ByteArray, id: String, json: String, nonce: ByteArray?): String =
        if (nonce == null) Aead.seal(vaultKey, Encoding.utf8(json), aad(id))
        else Aead.seal(vaultKey, Encoding.utf8(json), aad(id), nonce)
}
