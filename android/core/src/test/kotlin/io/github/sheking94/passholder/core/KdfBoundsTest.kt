package io.github.sheking94.passholder.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** KDF edge cases; the TypeScript counterparts are in core/test/edge-cases.test.ts. */
class KdfBoundsTest {
    private val ok = Kdf.newParams()

    @Test
    fun `rejects parameters a malicious peer could use against the phone`() {
        Kdf.assertAcceptable(ok.copy(memoryKiB = Kdf.MAX_MEMORY_KIB, iterations = Kdf.MAX_ITERATIONS, parallelism = Kdf.MAX_PARALLELISM))
        for (bad in listOf(
            ok.copy(salt = Encoding.toBase64(ByteArray(8))),
            ok.copy(parallelism = 0),
            ok.copy(iterations = Kdf.MAX_ITERATIONS + 1),
            ok.copy(parallelism = Kdf.MAX_PARALLELISM + 1),
        )) {
            assertThrows<IllegalArgumentException> { Kdf.assertAcceptable(bad) }
        }
    }

    @Test
    fun `NFC normalization gives the same key for the same password typed two ways`() {
        val params = ok.copy(memoryKiB = Kdf.MIN_MEMORY_KIB, iterations = Kdf.MIN_ITERATIONS, parallelism = 1)
        val composed = Kdf.deriveKeys("ą", params)
        val decomposed = Kdf.deriveKeys("ą", params)
        assertEquals(Encoding.toHex(composed.encKey), Encoding.toHex(decomposed.encKey))
    }
}
