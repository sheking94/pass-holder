package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.Kdf
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.VaultCrypto
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** The phone's vault-key operations: wrapping with the master password and the two checks of a key. */
internal object VaultKeys {
    const val KEY_LENGTH = 32
    private val KEY_CHECK_INFO = Encoding.utf8("passholder/v2/key-check")

    /** Base64 HMAC-SHA256(vaultKey, "passholder/v2/key-check"): checks a vault key without any entry. */
    fun keyCheck(vaultKey: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(vaultKey, "HmacSHA256")) }
        return Encoding.toBase64(mac.doFinal(KEY_CHECK_INFO))
    }

    /** [vaultKey] has the stored [keyCheck]; compared in constant time. */
    fun matchesKeyCheck(vaultKey: ByteArray, keyCheck: String): Boolean =
        MessageDigest.isEqual(Encoding.utf8(keyCheck(vaultKey)), Encoding.utf8(keyCheck))

    /** Wraps [vaultKey] with [password] under new KDF parameters (a new salt). */
    fun wrapWithPassword(password: String, vaultKey: ByteArray): WrappedVault {
        val kdf = Kdf.newParams()
        val keys = Kdf.deriveKeys(password, kdf)
        return try {
            WrappedVault(kdf, VaultCrypto.wrapVaultKey(keys.encKey, vaultKey))
        } finally {
            keys.encKey.fill(0)
        }
    }

    /** The vault key; [ErrorCode.WRONG_MASTER_PASSWORD] when [password] does not unwrap it. */
    fun unwrap(password: String, vault: WrappedVault): ByteArray {
        // Security review V3-I5: host.json is read from disk, so its KDF gets the same bounds as one from the network.
        Kdf.assertAcceptable(vault.kdf)
        val keys = Kdf.deriveKeys(password, vault.kdf)
        return try {
            VaultCrypto.unwrapVaultKey(keys.encKey, vault.wrappedVaultKey)
        } catch (e: Exception) {
            throw PassHolderException(ErrorCode.WRONG_MASTER_PASSWORD, cause = e)
        } finally {
            keys.encKey.fill(0)
        }
    }

    /** [ErrorCode.WRONG_MASTER_PASSWORD] unless [password] unwraps exactly [expectedKey] (the unlocked one). */
    fun verifyPassword(password: String, vault: WrappedVault, expectedKey: ByteArray) {
        val checked = unwrap(password, vault)
        try {
            if (!MessageDigest.isEqual(checked, expectedKey)) throw PassHolderException(ErrorCode.WRONG_MASTER_PASSWORD)
        } finally {
            checked.fill(0)
        }
    }

    /** Runs [block], which takes ownership of [key]; zeroes [key] if it throws. */
    inline fun <T> wipeOnFailure(key: ByteArray, block: () -> T): T = try {
        block()
    } catch (e: Throwable) {
        key.fill(0)
        throw e
    }
}
