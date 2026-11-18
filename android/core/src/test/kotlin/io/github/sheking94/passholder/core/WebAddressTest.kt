package io.github.sheking94.passholder.core

import io.github.sheking94.passholder.core.autofill.matchUrl
import io.github.sheking94.passholder.core.save.saveUrl
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class WebAddressTest {
    @Test
    fun normalizeHostLowercasesAndDropsWwwAndOneTrailingDot() {
        assertEquals("example.com", normalizeHost("WWW.Example.COM."))
        assertEquals("wwwx.example.com", normalizeHost("wwwx.example.com"))
        assertEquals("example.com.", normalizeHost("example.com.."))
    }

    // Review V3 CS5: the order of the two steps matters only for "www.". The save vectors fix it to "" ("empty host
    // after www removal"); autofill matching, which used the other order ("www"), now follows them.
    @Test
    fun wwwDotHasNoHost() {
        assertEquals("", normalizeHost("www."))
        assertNull(saveUrl("https://www."))
        assertNull(matchUrl("https://www./", "www"))
    }

    @Test
    fun parseWebAddressAssumesHttpsOnlyWhenAsked() {
        val address = parseWebAddress("example.com", assumeHttps = true)!!
        assertEquals(listOf<Any>(true, "example.com", ""), listOf(address.https, address.host, address.port))
        assertNull(parseWebAddress("example.com", assumeHttps = false))
    }

    @Test
    fun parseWebAddressKeepsOtherPortsAndRefusesOtherSchemes() {
        val address = parseWebAddress(" http://www.a.pl:8080/x ", assumeHttps = false)!!
        assertEquals(listOf<Any>(false, "a.pl", "8080"), listOf(address.https, address.host, address.port))
        assertEquals("", parseWebAddress("https://a.pl:443", assumeHttps = false)!!.port)
        assertNull(parseWebAddress("ftp://a.pl", assumeHttps = true))
    }

    @Test
    fun hostOfGivesTheNormalizedHostOfAnySchemeLikeTheExtension() {
        assertEquals("example.com", hostOf("https://www.Example.com/login"))
        assertEquals("example.org", hostOf("example.org/x"))
        assertEquals("files.example.com", hostOf("ftp://files.example.com"))
        assertEquals("[::1]", hostOf("http://[::1]:8080"))
        // As in the extension: an IDN host becomes punycode (it stayed Unicode before review V3 CS5).
        assertEquals("xn--a-uga0vji.pl", hostOf("https://łóża.pl"))
        assertNull(hostOf("nie adres"))
    }
}
