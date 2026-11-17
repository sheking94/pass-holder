package io.github.sheking94.passholder.core

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM from docs/SPEC.md §3, same as core/src/cipher.ts.
 * Output is Base64 of: version (1 byte) || nonce (12 bytes) || ciphertext || tag (16 bytes).
 */
object Aead {
    private const val FORMAT_VERSION: Byte = 0x01
    private const val NONCE_LENGTH = 12
    private const val TAG_BITS = 128

    /** [nonce] is only for test vectors; normal callers leave it out and get a random one. */
    fun seal(key: ByteArray, plaintext: ByteArray, aad: String, nonce: ByteArray = Encoding.randomBytes(NONCE_LENGTH)): String {
        require(key.size == 32) { "Key must be 32 bytes" }
        require(nonce.size == NONCE_LENGTH) { "Nonce must be 12 bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(Encoding.utf8(aad))
        val ciphertext = cipher.doFinal(plaintext)
        return Encoding.toBase64(byteArrayOf(FORMAT_VERSION) + nonce + ciphertext)
    }

    /** Throws [javax.crypto.AEADBadTagException] if the key is wrong or the blob was changed. */
    fun open(key: ByteArray, blob: String, aad: String): ByteArray {
        require(key.size == 32) { "Key must be 32 bytes" }
        val bytes = Encoding.fromBase64(blob)
        require(bytes.size >= 1 + NONCE_LENGTH + 16) { "Blob too short" }
        require(bytes[0] == FORMAT_VERSION) { "Unsupported blob version: ${bytes[0]}" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, bytes, 1, NONCE_LENGTH))
        cipher.updateAAD(Encoding.utf8(aad))
        return cipher.doFinal(bytes, 1 + NONCE_LENGTH, bytes.size - 1 - NONCE_LENGTH)
    }
}
