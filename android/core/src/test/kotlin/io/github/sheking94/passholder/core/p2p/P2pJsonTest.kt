package io.github.sheking94.passholder.core.p2p

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Duration

class P2pJsonTest {
    private fun safe(text: String) = P2pJson.safeLong(Json.parseToJsonElement(text))

    @Test
    fun acceptsIntegersInSafeRange() {
        assertEquals(1L, safe("1.0"))
        assertEquals(1000L, safe("1e3"))
        assertEquals(0L, safe("0"))
        assertEquals(9007199254740991L, safe("9007199254740991"))
    }

    @Test
    fun rejectsEverythingElse() {
        assertNull(safe("\"1\""))
        assertNull(safe("-1"))
        assertNull(safe("9007199254740992"))
        assertNull(safe("1.5"))
        assertNull(safe("true"))
        assertNull(safe("null"))
        assertNull(P2pJson.safeLong(null))
    }

    @Test
    fun hugeExponentsAreRejectedQuickly() {
        org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(Duration.ofSeconds(2)) {
            assertNull(safe("1e999999999"))
            assertNull(safe("1e-999999999"))
            assertNull(safe("0e999999999"))
            assertTrue(true)
        }
    }
}
