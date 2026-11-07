package io.github.sheking94.passholder.core.p2p

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketException

class LocalAddressesTest {
    private fun ip(text: String): InetAddress = InetAddress.getByName(text)

    @Test
    fun formatsIpv4WithTailscaleLastAndSkipsLinkLocalAndIpv6() {
        val addresses = listOf("192.168.1.5", "100.101.102.103", "10.0.0.2", "169.254.1.1", "fe80::1").map(::ip)
        assertEquals(
            listOf("http://192.168.1.5:8787", "http://10.0.0.2:8787", "http://100.101.102.103:8787"),
            LocalAddresses.format(addresses, 8787),
        )
    }

    @Test
    fun cgnatRangeIsExactly100_64Slash10() {
        val addresses = listOf("100.128.0.1", "100.64.0.1", "100.63.255.255", "100.127.255.254").map(::ip)
        assertEquals(
            listOf("http://100.128.0.1:1", "http://100.63.255.255:1", "http://100.64.0.1:1", "http://100.127.255.254:1"),
            LocalAddresses.format(addresses, 1),
        )
    }

    @Test
    fun skipsLoopbackDuplicatesAndKeepsAtMostMaxAddresses() {
        val many = (1..30).map { ip("10.0.0.$it") }
        val out = LocalAddresses.format(listOf(ip("127.0.0.1"), ip("10.0.0.1")) + many, 80)
        assertEquals(Pairing.MAX_ADDRESSES, out.size)
        assertEquals((1..16).map { "http://10.0.0.$it:80" }, out)
    }

    @Test
    fun listIsEmptyWhenEnumerationFails() {
        assertEquals(emptyList<String>(), LocalAddresses.list(8787) { throw SocketException("no network") })
        assertEquals(emptyList<String>(), LocalAddresses.list(8787) { emptyList() })
    }

    @Test
    fun listOfThisMachineHasOnlyIpv4UrlsWithoutLoopback() {
        val out = LocalAddresses.list(8787)
        assertTrue(out.size <= Pairing.MAX_ADDRESSES)
        for (url in out) {
            assertTrue(Regex("""http://\d+\.\d+\.\d+\.\d+:8787""").matches(url), url)
            assertTrue(!url.startsWith("http://127.") && !url.startsWith("http://169.254."), url)
        }
        // The loopback interface alone gives nothing.
        val lo = NetworkInterface.getNetworkInterfaces().toList().filter { it.isLoopback }
        assertEquals(emptyList<String>(), LocalAddresses.list(8787) { lo })
    }
}
