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
    private const val TAG_BITS = GCM_TAG_BYTES * 8

    /** Bytes [seal] adds to the plaintext: version (1) + nonce (12) + tag (16) = 29. */
    const val SEAL_OVERHEAD_BYTES = 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES

    /** Seals with a random nonce. */
    fun seal(key: ByteArray, plaintext: ByteArray, aad: String): String = seal(key, plaintext, aad, Encoding.randomBytes(GCM_NONCE_BYTES))

    /**
     * [seal] with a caller-given nonce. Production code passes a fresh random one (as [seal] and `FileChunks.encrypt`
     * do); a fixed nonce is only for test vectors: reusing a nonce with the same key breaks AES-GCM.
     */
    internal fun seal(key: ByteArray, plaintext: ByteArray, aad: String, nonce: ByteArray): String {
        require(key.size == KEY_BYTES) { "Key must be 32 bytes" }
        require(nonce.size == GCM_NONCE_BYTES) { "Nonce must be 12 bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(Encoding.utf8(aad))
        val ciphertext = cipher.doFinal(plaintext)
        return Encoding.toBase64(byteArrayOf(FORMAT_VERSION) + nonce + ciphertext)
    }

    /** Throws [javax.crypto.AEADBadTagException] if the key is wrong or the blob was changed. */
    fun open(key: ByteArray, blob: String, aad: String): ByteArray {
        require(key.size == KEY_BYTES) { "Key must be 32 bytes" }
        val bytes = Encoding.fromBase64(blob)
        require(bytes.size >= SEAL_OVERHEAD_BYTES) { "Blob too short" }
        require(bytes[0] == FORMAT_VERSION) { "Unsupported blob version: ${bytes[0]}" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, bytes, 1, GCM_NONCE_BYTES))
        cipher.updateAAD(Encoding.utf8(aad))
        return cipher.doFinal(bytes, 1 + GCM_NONCE_BYTES, bytes.size - 1 - GCM_NONCE_BYTES)
    }
}
