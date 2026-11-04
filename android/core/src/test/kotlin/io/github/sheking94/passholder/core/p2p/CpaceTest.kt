package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File

class CpaceTest {
    private val raw = Json.parseToJsonElement(
        File(System.getProperty("passholder.repoRoot"), "core/test-vectors/cpace-ristretto255.json").readText(),
    ).jsonObject

    private fun hex(key: String) = raw.getValue(key).jsonPrimitive.content
    private fun bytes(key: String) = Encoding.fromHex(hex(key))
    private fun toHex(b: ByteArray) = Encoding.toHex(b)
    private fun utf8(s: String) = Encoding.utf8(s)

    private val prs = bytes("PRS")
    private val ci = bytes("CI")
    private val sid = bytes("sid")
    private val adA = bytes("ADa")
    private val adB = bytes("ADb")
    private val ya = bytes("ya")
    private val yb = bytes("yb")
    private val bigYa = bytes("Ya")
    private val bigYb = bytes("Yb")

    private fun pair(codeA: String, codeB: String): Pair<ByteArray, ByteArray> {
        val s = Encoding.randomBytes(16)
        val a = Cpace.start(utf8(codeA), Cpace.PAIRING_CI, s, utf8("A"))
        val b = Cpace.start(utf8(codeB), Cpace.PAIRING_CI, s, utf8("B"))
        return Cpace.finish(a.state, b.message, CpaceRole.INITIATOR) to Cpace.finish(b.state, a.message, CpaceRole.RESPONDER)
    }

    private fun assertInvalid(block: () -> Unit) {
        assertEquals("CPace: invalid peer element", assertThrows<IllegalArgumentException> { block() }.message)
    }

    @Test
    fun encodesLengthsLikeTheDraftVectors() {
        assertEquals("00", toHex(Cpace.lvCat(ByteArray(0))))
        assertEquals(
            "043132333401350003363738",
            toHex(Cpace.lvCat(utf8("1234"), utf8("5"), ByteArray(0), utf8("678"))),
        )
        val r127 = ByteArray(127) { it.toByte() }
        val r128 = ByteArray(128) { it.toByte() }
        assertEquals("7f00", toHex(Cpace.lvCat(r127).copyOfRange(0, 2)))
        assertEquals("800100", toHex(Cpace.lvCat(r128).copyOfRange(0, 3)))
        assertEquals(130, Cpace.lvCat(r128).size)
    }

    @Test
    fun pairingCiIsUtf8Label() {
        assertEquals("passholder/v2/pair", String(Cpace.PAIRING_CI, Charsets.UTF_8))
    }

    @Test
    fun reproducesTheDraftTestVector() {
        val a = Cpace.start(prs, ci, sid, adA, ya)
        val b = Cpace.start(prs, ci, sid, adB, yb)
        assertEquals(toHex(Cpace.lvCat(bigYa, adA)), toHex(a.message))
        assertEquals(toHex(Cpace.lvCat(bigYb, adB)), toHex(b.message))
        assertEquals(hex("ISK_IR"), toHex(Cpace.finish(a.state, b.message, CpaceRole.INITIATOR)))
        assertEquals(hex("ISK_IR"), toHex(Cpace.finish(b.state, a.message, CpaceRole.RESPONDER)))
    }

    @Test
    fun reproducesIntermediateValues() {
        assertEquals(hex("generator_string"), toHex(Cpace.generatorString(prs, ci, sid)))
        assertEquals(hex("generator_hash"), toHex(Cpace.generatorHash(prs, ci, sid)))
        assertEquals(hex("g"), toHex(Cpace.calculateGenerator(prs, ci, sid)))
        assertEquals(hex("K"), toHex(Cpace.sharedPoint(ya, bigYb)))
        assertEquals(hex("K"), toHex(Cpace.sharedPoint(yb, bigYa)))
    }

    @Test
    fun sameCodeGivesSame64ByteKey() {
        val (ia, ib) = pair("12345678", "12345678")
        assertEquals(64, ia.size)
        assertEquals(toHex(ia), toHex(ib))
    }

    @Test
    fun differentCodeGivesDifferentKeys() {
        val (ia, ib) = pair("12345678", "12345679")
        assertNotEquals(toHex(ia), toHex(ib))
    }

    @Test
    fun bindsKeyToRoles() {
        val s = Encoding.randomBytes(16)
        val a = Cpace.start(utf8("12345678"), Cpace.PAIRING_CI, s, utf8("A"))
        val b = Cpace.start(utf8("12345678"), Cpace.PAIRING_CI, s, utf8("B"))
        val ia = Cpace.finish(a.state, b.message, CpaceRole.INITIATOR)
        val ib = Cpace.finish(b.state, a.message, CpaceRole.INITIATOR)
        assertNotEquals(toHex(ia), toHex(ib))
    }

    @Test
    fun rejectsIdentityAndGarbage() {
        val a = Cpace.start(utf8("12345678"), Cpace.PAIRING_CI, Encoding.randomBytes(16), ByteArray(0))
        val identity = Cpace.lvCat(ByteArray(32), ByteArray(0))
        val garbage = Cpace.lvCat(ByteArray(32) { 0xff.toByte() }, ByteArray(0))
        assertInvalid { Cpace.finish(a.state, identity, CpaceRole.INITIATOR) }
        assertInvalid { Cpace.finish(a.state, garbage, CpaceRole.INITIATOR) }
        assertInvalid { Cpace.finish(a.state, Cpace.lvCat(bytes("invalid_Y1"), adB), CpaceRole.RESPONDER) }
        assertInvalid { Cpace.finish(a.state, Cpace.lvCat(bytes("invalid_Y2_identity"), adB), CpaceRole.RESPONDER) }
    }

    @Test
    fun rejectsMalformedFraming() {
        val b = Cpace.start(prs, ci, sid, adB, yb)
        val a = Cpace.start(prs, ci, sid, adA, ya)
        val bad = listOf(
            ByteArray(0),
            bigYb, // raw element without framing
            b.message.copyOf(b.message.size - 1), // truncated
            b.message + byteArrayOf(0), // trailing byte
            Cpace.lvCat(bigYb, adB, ByteArray(0)), // third field
            Cpace.lvCat(bigYb.copyOf(31), adB), // short element
            Cpace.lvCat(bigYb + byteArrayOf(0), adB), // long element
            byteArrayOf(0x80.toByte()) + bigYb, // unterminated LEB128 length
            byteArrayOf(0x21) + bigYb.copyOf(5), // length larger than the rest
        )
        for (m in bad) assertInvalid { Cpace.finish(a.state, m, CpaceRole.INITIATOR) }
    }

    @Test
    fun rejectsInvalidSuppliedScalar() {
        assertThrows<IllegalArgumentException> { Cpace.start(prs, ci, sid, adA, ByteArray(31)) }
        assertThrows<IllegalArgumentException> { Cpace.start(prs, ci, sid, adA, ByteArray(32)) }
    }
}
