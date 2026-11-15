package io.github.sheking94.passholder.app

import android.net.NetworkCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNetworkCapabilities
import java.net.InetAddress

/** Security review V3-N2: sync mode answers on Wi-Fi, Ethernet and Tailscale, not on the cellular network. */
@RunWith(RobolectricTestRunner::class)
class SyncNetworksTest {
    private val home = InetAddress.getByName("192.168.1.5")
    private val tailscale = InetAddress.getByName("100.101.102.103")
    private val cgnat = InetAddress.getByName("100.70.1.2")
    private val other = InetAddress.getByName("10.8.0.2")

    private fun caps(vararg transports: Int): NetworkCapabilities {
        val caps = ShadowNetworkCapabilities.newInstance()
        transports.forEach { shadowOf(caps).addTransportType(it) }
        return caps
    }

    @Test
    fun `wifi and ethernet allow all their addresses, cellular none`() {
        assertEquals(listOf(home), SyncNetworks.allowed(caps(NetworkCapabilities.TRANSPORT_WIFI), listOf(home)))
        assertEquals(listOf(home), SyncNetworks.allowed(caps(NetworkCapabilities.TRANSPORT_ETHERNET), listOf(home)))
        // Carriers often give the phone a 100.64.0.0/10 address too: on the cellular network it does not count.
        assertEquals(emptyList<InetAddress>(), SyncNetworks.allowed(caps(NetworkCapabilities.TRANSPORT_CELLULAR), listOf(cgnat, home)))
    }

    @Test
    fun `a vpn allows only its tailscale addresses, also over wifi`() {
        val vpn = caps(NetworkCapabilities.TRANSPORT_VPN, NetworkCapabilities.TRANSPORT_WIFI)
        assertEquals(listOf(tailscale), SyncNetworks.allowed(vpn, listOf(tailscale, other)))
        assertEquals(emptyList<InetAddress>(), SyncNetworks.allowed(caps(NetworkCapabilities.TRANSPORT_VPN), listOf(other)))
    }

    @Test
    fun `tailscale range is 100 64 0 0 slash 10`() {
        assertTrue(SyncNetworks.isTailscale(InetAddress.getByName("100.64.0.0")))
        assertTrue(SyncNetworks.isTailscale(InetAddress.getByName("100.127.255.255")))
        assertFalse(SyncNetworks.isTailscale(InetAddress.getByName("100.128.0.0")))
        assertFalse(SyncNetworks.isTailscale(InetAddress.getByName("100.63.255.255")))
        assertFalse(SyncNetworks.isTailscale(InetAddress.getByName("::1")))
    }
}
