package io.github.sheking94.passholder.core.autofill

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Security review V3-S3: browsers and the apps of a login are recognized by their signing certificate. */
class VerifyAppTest {
    private val chrome = "com.android.chrome"
    private val chromeCert = TRUSTED_BROWSERS.getValue(chrome).single()
    private val other = "00".repeat(32)

    private fun verify(pkg: String, certs: Set<String>?, pinned: Set<String>? = null) =
        verifyApp(AppRequest(pkg, "bank.pl", "https"), certs, pinned)

    @Test
    fun `every trusted browser has well-formed digests`() {
        assertEquals(13, TRUSTED_BROWSERS.size)
        TRUSTED_BROWSERS.values.flatten().forEach { assertTrue(Regex("[0-9a-f]{64}").matches(it), it) }
    }

    @Test
    fun `browser with its certificate is verified, with another or unreadable is not`() {
        assertTrue(verify(chrome, setOf(chromeCert)).browserVerified)
        // A rotated key keeps the old certificate in the signing history.
        assertTrue(verify(chrome, setOf(other, chromeCert)).browserVerified)
        assertFalse(verify(chrome, setOf(other)).browserVerified)
        assertFalse(verify(chrome, null).browserVerified)
        assertFalse(verify("com.example.browser", setOf(chromeCert)).browserVerified)
    }

    @Test
    fun `app trusted on first use, then only with the remembered certificate`() {
        assertTrue(verify("pl.bank", setOf(other)).appVerified)
        assertTrue(verify("pl.bank", setOf(other), pinned = setOf(other)).appVerified)
        assertFalse(verify("pl.bank", setOf(chromeCert), pinned = setOf(other)).appVerified)
        assertFalse(verify("pl.bank", null).appVerified)
        assertFalse(verify("pl.bank", null, pinned = setOf(other)).appVerified)
    }

    @Test
    fun `claimed fields are kept`() {
        val r = verify(chrome, setOf(chromeCert))
        assertEquals(AppRequest(chrome, "bank.pl", "https", browserVerified = true, appVerified = true), r)
    }
}
