package io.github.sheking94.passholder.core

/** Wrapping of the vault key, docs/SPEC.md §2–3, same as core/src/vault.ts. */
object VaultCrypto {
    const val VAULT_KEY_AAD = "passholder/v1/vault-key"

    fun newVaultKey(): ByteArray = Encoding.randomBytes(KEY_BYTES)

    fun wrapVaultKey(encKey: ByteArray, vaultKey: ByteArray, nonce: ByteArray? = null): String =
        if (nonce == null) Aead.seal(encKey, vaultKey, VAULT_KEY_AAD) else Aead.seal(encKey, vaultKey, VAULT_KEY_AAD, nonce)

    /** Throws if the master password is wrong (the GCM tag does not verify). */
    fun unwrapVaultKey(encKey: ByteArray, wrapped: String): ByteArray {
        val key = Aead.open(encKey, wrapped, VAULT_KEY_AAD)
        require(key.size == KEY_BYTES) { "Vault key must be 32 bytes" }
        return key
    }
}
