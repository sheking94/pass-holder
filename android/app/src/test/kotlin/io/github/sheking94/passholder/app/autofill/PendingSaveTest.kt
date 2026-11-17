package io.github.sheking94.passholder.app.autofill

import io.github.sheking94.passholder.core.autofill.AppRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingSaveTest {
    private var now = 1_000L
    private val pending = PendingSave { now }
    private fun data(password: String) = SaveData(AppRequest("com.example.bank", null, null), "jan", password)

    @Test
    fun `take returns the candidate once and clears it`() {
        pending.put(data("a"))
        assertTrue(pending.hasFresh())
        assertEquals(data("a"), pending.take())
        assertNull(pending.take())
        assertFalse(pending.hasFresh())
    }

    @Test
    fun `a candidate older than 2 minutes is gone`() {
        pending.put(data("a"))
        now += 120_000
        assertEquals(data("a"), pending.take())
        pending.put(data("b"))
        now += 120_001
        assertFalse(pending.hasFresh())
        assertNull(pending.take())
    }

    @Test
    fun `put replaces an older candidate and clear drops it`() {
        pending.put(data("a"))
        pending.put(data("b"))
        assertEquals(data("b"), pending.take())
        pending.put(data("c"))
        pending.clear()
        assertNull(pending.take())
    }
}
