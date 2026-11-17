package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.assertCode
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class FramesTest {
    private val key = ByteArray(32) { it.toByte() }
    private fun pair() = CipherState(key) to CipherState(key)

    @Test
    fun `roundtrip with a 4-byte emoji straddling the frame boundary`() {
        // Prefix {"f":" is 6 bytes, "zażółć " is 11, so the emoji starts at byte 65517 and crosses 65519.
        val text = "za\u017c\u00f3\u0142\u0107 " + "a".repeat(65500) + "\uD83D\uDE00"
        val obj = JsonObject(mapOf("f" to JsonPrimitive(text)))
        val json = P2pJson.json.encodeToString(JsonObject.serializer(), obj)
        val bytes = Encoding.utf8(json)
        assertTrue(bytes[65518].toInt() and 0xC0 == 0x80, "boundary must fall inside the emoji")
        val (enc, dec) = pair()
        val frames = Frames.encrypt(enc, json)
        assertEquals(2, frames.size)
        assertEquals(obj, Frames.decrypt(dec, frames))
    }

    @Test
    fun `small payload is one frame`() {
        val (enc, dec) = pair()
        val frames = Frames.encrypt(enc, """{"a":1}""")
        assertEquals(1, frames.size)
        assertEquals(P2pJson.json.parseToJsonElement("""{"a":1}"""), Frames.decrypt(dec, frames))
    }

    private fun threeFrames(): Pair<List<String>, CipherState> {
        val (enc, dec) = pair()
        val json = "\"" + "a".repeat(2 * Frames.MAX_FRAME_PLAINTEXT) + "\""
        val frames = Frames.encrypt(enc, json)
        assertEquals(3, frames.size)
        return frames to dec
    }

    @Test
    fun `missing last frame fails`() {
        val (frames, dec) = threeFrames()
        assertThrows<IllegalArgumentException> { Frames.decrypt(dec, frames.dropLast(1)) }
    }

    @Test
    fun `swapped frames fail`() {
        val (frames, dec) = threeFrames()
        assertCode(ErrorCode.NOISE_FAILED) { Frames.decrypt(dec, listOf(frames[1], frames[0], frames[2])) }
    }

    @Test
    fun `empty list fails`() {
        assertThrows<IllegalArgumentException> { Frames.decrypt(CipherState(key), emptyList()) }
    }

    @Test
    fun `flipped byte fails`() {
        val (enc, dec) = pair()
        val frames = Frames.encrypt(enc, """{"a":1}""")
        val raw = Encoding.fromBase64(frames[0])
        raw[0] = (raw[0].toInt() xor 1).toByte()
        assertCode(ErrorCode.NOISE_FAILED) { Frames.decrypt(dec, listOf(Encoding.toBase64(raw))) }
    }

    @Test
    fun `invalid base64, invalid utf8 and invalid json fail as IllegalArgumentException`() {
        assertThrows<IllegalArgumentException> { Frames.decrypt(CipherState(key), listOf("!!notbase64")) }
        val (e1, d1) = pair()
        val badUtf8 = Encoding.toBase64(e1.encrypt(ByteArray(0), byteArrayOf(0xC3.toByte(), 0x28)))
        assertThrows<IllegalArgumentException> { Frames.decrypt(d1, listOf(badUtf8)) }
        val (e2, d2) = pair()
        val badJson = Frames.encrypt(e2, "{not json")
        assertThrows<IllegalArgumentException> { Frames.decrypt(d2, badJson) }
    }

    @Test
    fun `exhausted nonce surfaces as NOISE_FAILED`() {
        val enc = CipherState(key, ULong.MAX_VALUE - 1uL)
        val frames = Frames.encrypt(enc, """{"a":1}""")
        val dec = CipherState(key, ULong.MAX_VALUE)
        assertCode(ErrorCode.NOISE_FAILED) { Frames.decrypt(dec, frames) }
    }
}
