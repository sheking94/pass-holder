package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.GCM_TAG_BYTES
import io.github.sheking94.passholder.core.PassHolderException
import kotlinx.serialization.json.JsonElement
import java.io.ByteArrayOutputStream

/** Splits a JSON payload into ordered Noise transport frames (Base64) and back. */
object Frames {
    /** Noise transport message limit (65535) minus the 16-byte AEAD tag. */
    const val MAX_FRAME_PLAINTEXT = MAX_NOISE_MESSAGE - GCM_TAG_BYTES

    /** Most frames a 1 MiB body may legitimately carry. */
    const val MAX_FRAMES = 18

    private val NO_AD = ByteArray(0)

    /** Encrypts the UTF-8 bytes of [json] as sequential frames; chunks are cut by bytes, not characters. */
    fun encrypt(cipher: CipherState, json: String): List<String> {
        val bytes = Encoding.utf8(json)
        val frames = ArrayList<String>()
        var i = 0
        while (i < bytes.size) {
            val end = minOf(i + MAX_FRAME_PLAINTEXT, bytes.size)
            frames.add(Encoding.toBase64(cipher.encrypt(NO_AD, bytes.copyOfRange(i, end))))
            i = end
        }
        return frames
    }

    /**
     * Decrypts frames in order, concatenates, decodes strictly and parses. A frame that does not decrypt is
     * [ErrorCode.NOISE_FAILED]; every other failure is an IllegalArgumentException.
     */
    fun decrypt(cipher: CipherState, frames: List<String>): JsonElement = try {
        val all = ByteArrayOutputStream()
        for (frame in frames) all.write(cipher.decrypt(NO_AD, Encoding.fromBase64(frame)))
        P2pJson.json.parseToJsonElement(Encoding.fromUtf8(all.toByteArray()))
    } catch (e: PassHolderException) {
        throw e
    } catch (e: IllegalArgumentException) {
        throw e
    } catch (e: Exception) {
        throw IllegalArgumentException("Frames: invalid payload", e)
    }
}
