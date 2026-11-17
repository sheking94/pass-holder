package io.github.sheking94.passholder.core.p2p

import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketException

/** The phone's own addresses the extension can reach it at, as `http://a.b.c.d:port`. */
object LocalAddresses {
    /** IPv4 addresses of interfaces that are up and not loopback; empty when the interfaces cannot be listed. */
    fun list(
        port: Int,
        interfaces: () -> List<NetworkInterface> = { NetworkInterface.getNetworkInterfaces()?.toList().orEmpty() },
    ): List<String> = try {
        format(interfaces().filter { it.isUp && !it.isLoopback }.flatMap { it.inetAddresses.toList() }, port)
    } catch (_: SocketException) {
        emptyList()
    }

    /**
     * IPv4 only, without loopback and link-local (169.254.*) addresses and duplicates; the Tailscale range
     * 100.64.0.0/10 goes last (the home network is faster), at most [Pairing.MAX_ADDRESSES].
     */
    fun format(addresses: List<InetAddress>, port: Int): List<String> = addresses
        .filterIsInstance<Inet4Address>()
        .filter { !it.isLoopbackAddress && !it.isLinkLocalAddress }
        .distinctBy { it.hostAddress }
        .sortedBy { isTailscale(it) }
        .take(Pairing.MAX_ADDRESSES)
        .map { "http://${it.hostAddress}:$port" }

    /** Tailscale gives each device an address in 100.64.0.0/10. */
    fun isTailscale(address: InetAddress): Boolean {
        if (address !is Inet4Address) return false
        val b = address.address
        return b[0].toInt() and 0xff == 100 && (b[1].toInt() and 0xc0) == 64
    }
}
