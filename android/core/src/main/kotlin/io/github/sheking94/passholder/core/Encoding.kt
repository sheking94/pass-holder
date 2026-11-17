package io.github.sheking94.passholder.core

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64

/** Byte helpers matching core/src/encoding.ts. */
object Encoding {
    private val random = SecureRandom()

    /** UTF-8 bytes of a string, normalized to NFC so the same password typed on any device gives the same bytes. */
    fun utf8(text: String): ByteArray = Normalizer.normalize(text, Normalizer.Form.NFC).toByteArray(Charsets.UTF_8)

    /** Strict UTF-8 decoding: invalid bytes throw IllegalArgumentException instead of turning into replacement characters. */
    fun fromUtf8(bytes: ByteArray): String = try {
        decodeUtf8Strict(bytes)
    } catch (e: CharacterCodingException) {
        throw IllegalArgumentException("Invalid UTF-8", e)
    }

    /** Strict UTF-8 decoding like [fromUtf8]; null for invalid bytes. */
    fun fromUtf8OrNull(bytes: ByteArray): String? = try {
        decodeUtf8Strict(bytes)
    } catch (_: CharacterCodingException) {
        null
    }

    private fun decodeUtf8Strict(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()

    /** SHA-256 of the bytes as lowercase hex. */
    fun sha256Hex(bytes: ByteArray): String = toHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    /** Standard Base64 with padding (RFC 4648 §4), the same as btoa() in the TypeScript core. */
    fun toBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun fromBase64(text: String): ByteArray = Base64.getDecoder().decode(text)

    fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "Invalid hex length" }
        return ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    fun randomBytes(length: Int): ByteArray = ByteArray(length).also(random::nextBytes)

    /** Uniform random integer in [0, max), used by the password generator. SecureRandom.nextInt already rejects biased values. */
    fun randomIndex(max: Int): Int {
        require(max > 0) { "Invalid range" }
        return random.nextInt(max)
    }
}
