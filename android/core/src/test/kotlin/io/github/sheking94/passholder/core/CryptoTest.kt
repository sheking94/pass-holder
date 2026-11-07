package io.github.sheking94.passholder.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import javax.crypto.AEADBadTagException

class CryptoTest {
    private val key = Encoding.randomBytes(32)

    @Test
    fun `round trip with a random nonce`() {
        val a = Aead.seal(key, Encoding.utf8("hasło"), "aad")
        val b = Aead.seal(key, Encoding.utf8("hasło"), "aad")
        assertNotEquals(a, b)
        assertEquals("hasło", Encoding.fromUtf8(Aead.open(key, a, "aad")))
    }

    @Test
    fun `wrong key, wrong aad or a changed byte fail`() {
        val blob = Aead.seal(key, byteArrayOf(1, 2, 3), "passholder/v1/entry/a")
        assertThrows<AEADBadTagException> { Aead.open(Encoding.randomBytes(32), blob, "passholder/v1/entry/a") }
        // A blob cannot be moved to another entry: the id is part of the AAD.
        assertThrows<AEADBadTagException> { Aead.open(key, blob, "passholder/v1/entry/b") }
        val bytes = Encoding.fromBase64(blob).also { it[20] = (it[20] + 1).toByte() }
        assertThrows<AEADBadTagException> { Aead.open(key, Encoding.toBase64(bytes), "passholder/v1/entry/a") }
    }

    @Test
    fun `rejects KDF parameters weaker than the minimum`() {
        val ok = Kdf.newParams()
        Kdf.assertAcceptable(ok)
        assertThrows<IllegalArgumentException> { Kdf.assertAcceptable(ok.copy(memoryKiB = 1024)) }
        assertThrows<IllegalArgumentException> { Kdf.assertAcceptable(ok.copy(iterations = 1)) }
        assertThrows<IllegalArgumentException> { Kdf.assertAcceptable(ok.copy(alg = "pbkdf2")) }
        assertThrows<IllegalArgumentException> { Kdf.assertAcceptable(ok.copy(memoryKiB = 4_000_000)) }
    }

    @Test
    fun `HKDF matches RFC 5869 test case 3 (empty salt and info)`() {
        // RFC 5869 A.3 uses 42 bytes of output; our function returns the first 32 of them.
        val ikm = Encoding.fromHex("0b".repeat(22))
        assertEquals(
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d",
            Encoding.toHex(Kdf.hkdfSha256(ikm, ByteArray(0))),
        )
    }
}
