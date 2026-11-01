package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

/** What the user sees and edits. */
@Serializable
data class Credentials(val name: String, val username: String, val password: String)

/**
 * Decrypted content of a live entry on the wire. Field order matters only for the test vectors:
 * it gives the same JSON bytes as JSON.stringify in the TypeScript core.
 */
@Serializable
internal data class EntryPayload(val name: String, val username: String, val password: String, val modifiedAt: Long)

/** Decrypted content of a deleted entry (tombstone). */
@Serializable
internal data class TombstonePayload(val modifiedAt: Long)

/** Wrapping of the vault key and encryption of entries, docs/SPEC.md §2–4, same as core/src/vault.ts. */
object VaultCrypto {
    const val VAULT_KEY_AAD = "passholder/v1/vault-key"

    internal val json = Json { ignoreUnknownKeys = true }

    fun entryAad(id: String) = "passholder/v1/entry/$id"

    fun newVaultKey(): ByteArray = Encoding.randomBytes(32)

    fun wrapVaultKey(encKey: ByteArray, vaultKey: ByteArray, nonce: ByteArray? = null): String =
        if (nonce == null) Aead.seal(encKey, vaultKey, VAULT_KEY_AAD) else Aead.seal(encKey, vaultKey, VAULT_KEY_AAD, nonce)

    /** Throws if the master password is wrong (the GCM tag does not verify). */
    fun unwrapVaultKey(encKey: ByteArray, wrapped: String): ByteArray {
        val key = Aead.open(encKey, wrapped, VAULT_KEY_AAD)
        require(key.size == 32) { "Vault key must be 32 bytes" }
        return key
    }

    /** Encrypts what the server stores for an entry: the credentials, or only the time for a tombstone. */
    fun encryptEntry(vaultKey: ByteArray, entry: LocalEntry): String {
        val text = when (val c = entry.credentials) {
            null -> json.encodeToString(TombstonePayload(entry.modifiedAt))
            else -> json.encodeToString(EntryPayload(c.name, c.username, c.password, entry.modifiedAt))
        }
        return Aead.seal(vaultKey, Encoding.utf8(text), entryAad(entry.id))
    }

    const val INCONSISTENT_RECORD =
        "Serwer zwrócił wpis, którego flaga usunięcia nie zgadza się z zaszyfrowaną treścią. Synchronizacja przerwana, dane na tym urządzeniu są bez zmian."

    /**
     * Decrypts a record from the server. The AAD ties the blob to its id, so the server cannot swap blobs.
     * The deleted flag is plain text from the server, so the payload must agree with it: a tombstone holds
     * nothing but modifiedAt, an entry has the credentials (S2 of the security review, same as
     * parseTombstoneData in core/src/vault.ts). Without this check a server could delete entries everywhere.
     */
    fun decryptRecord(vaultKey: ByteArray, record: RemoteRecord): LocalEntry {
        val text = Encoding.fromUtf8(Aead.open(vaultKey, record.blob, entryAad(record.id)))
        return try {
            if (record.deleted) {
                check(json.parseToJsonElement(text).jsonObject.keys == setOf("modifiedAt"))
                val p = json.decodeFromString<TombstonePayload>(text)
                LocalEntry(record.id, record.revision, dirty = false, modifiedAt = p.modifiedAt, credentials = null)
            } else {
                val p = json.decodeFromString<EntryPayload>(text)
                LocalEntry(record.id, record.revision, dirty = false, modifiedAt = p.modifiedAt, credentials = Credentials(p.name, p.username, p.password))
            }
        } catch (e: IllegalArgumentException) {
            throw IllegalStateException(INCONSISTENT_RECORD, e)
        } catch (e: IllegalStateException) {
            throw IllegalStateException(INCONSISTENT_RECORD, e)
        }
    }
}
