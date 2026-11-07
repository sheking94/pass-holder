package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable

/** What the user sees and edits. */
@Serializable
data class Credentials(val name: String, val username: String, val password: String)

/** Wrapping of the vault key, docs/SPEC.md §2–3, same as core/src/vault.ts. */
object VaultCrypto {
    const val VAULT_KEY_AAD = "passholder/v1/vault-key"

    fun newVaultKey(): ByteArray = Encoding.randomBytes(32)

    fun wrapVaultKey(encKey: ByteArray, vaultKey: ByteArray, nonce: ByteArray? = null): String =
        if (nonce == null) Aead.seal(encKey, vaultKey, VAULT_KEY_AAD) else Aead.seal(encKey, vaultKey, VAULT_KEY_AAD, nonce)

    /** Throws if the master password is wrong (the GCM tag does not verify). */
    fun unwrapVaultKey(encKey: ByteArray, wrapped: String): ByteArray {
        val key = Aead.open(encKey, wrapped, VAULT_KEY_AAD)
        require(key.size == 32) { "Vault key must be 32 bytes" }
        return key
    }
}
