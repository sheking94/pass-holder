package io.github.sheking94.passholder.core.p2p

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HlcTest {
    private fun parse(text: String): JsonElement = Json.parseToJsonElement(text)

    @Test
    fun ordersByMsThenCounterThenDeviceId() {
        assertEquals(-1, Hlc(1, 9, "z").compareTo(Hlc(2, 0, "a")).coerceIn(-1, 1))
        assertEquals(1, Hlc(2, 1, "a").compareTo(Hlc(2, 0, "z")).coerceIn(-1, 1))
        assertEquals(-1, Hlc(2, 1, "a").compareTo(Hlc(2, 1, "b")).coerceIn(-1, 1))
        assertEquals(0, Hlc(2, 1, "a").compareTo(Hlc(2, 1, "a")))
    }

    @Test
    fun keepsGrowingWhenWallClockGoesBackwards() {
        var t = 1000L
        val clock = HlcClock("A", { t })
        val a = clock.tick(); t = 500; val b = clock.tick(); val c = clock.tick()
        assertEquals(Hlc(1000, 0, "A"), a)
        assertEquals(Hlc(1000, 1, "A"), b)
        assertTrue(b < c)
    }

    @Test
    fun ticksAfterObservedRemoteClockThatRunsAhead() {
        val clock = HlcClock("B", { 100 })
        clock.observe(Hlc(99_999, 4, "A"))
        assertEquals(Hlc(99_999, 5, "B"), clock.tick())
    }

    @Test
    fun resetsCounterWhenWallClockMovesForward() {
        var t = 10L
        val clock = HlcClock("A", { t })
        clock.tick(); clock.tick(); t = 11
        assertEquals(Hlc(11, 0, "A"), clock.tick())
    }

    @Test
    fun observeIgnoresOlderRemoteAndKeepsLast() {
        val clock = HlcClock("A", { 100 }, Hlc(500, 2, "A"))
        clock.observe(Hlc(500, 2, "B"))
        clock.observe(Hlc(400, 9, "B"))
        assertEquals(Hlc(500, 2, "A"), clock.last)
        assertNull(HlcClock("A").last)
    }

    @Test
    fun rejectsMalformedValues() {
        val bad = listOf(
            "{}", """{"ms":-1,"c":0,"d":"a"}""", """{"ms":1.5,"c":0,"d":"a"}""", """{"ms":1,"c":0,"d":""}""",
            """{"ms":1,"c":0,"d":"${"x".repeat(65)}"}""", """{"ms":"1","c":0,"d":"a"}""", """{"ms":1,"c":-1,"d":"a"}""",
            """{"ms":9007199254740992,"c":0,"d":"a"}""", """{"ms":1,"c":0,"d":5}""", "[]", "5",
        )
        for (text in bad) {
            val e = assertThrows(IllegalArgumentException::class.java, { parseHlc(parse(text)) }, text)
            assertEquals("Invalid HLC", e.message)
        }
        for (v in listOf<JsonElement?>(null, JsonNull)) {
            assertEquals("Invalid HLC", assertThrows(IllegalArgumentException::class.java) { parseHlc(v) }.message)
        }
        assertEquals(Hlc(1, 2, "a"), parseHlc(parse("""{"ms":1,"c":2,"d":"a","extra":1}""")))
        assertEquals(Hlc(P2pJson.MAX_SAFE_INTEGER, 0, "x".repeat(64)), parseHlc(parse("""{"ms":9007199254740991,"c":0,"d":"${"x".repeat(64)}"}""")))
    }
}
