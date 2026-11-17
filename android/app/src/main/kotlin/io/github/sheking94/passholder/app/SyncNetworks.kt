package io.github.sheking94.passholder.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import io.github.sheking94.passholder.core.p2p.LocalAddresses
import java.net.InetAddress

/**
 * The phone's addresses that sync mode answers on (security review V3-N2): Wi-Fi, Ethernet and Tailscale. The
 * cellular network is left out, so nobody reaches the phone's server there, and its address is not given to the
 * extension. Read fresh from [ConnectivityManager] each time, so a network that came up later counts too.
 */
class SyncNetworks(context: Context) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    /** Addresses of the allowed networks; empty when the system does not answer. */
    fun addresses(): List<InetAddress> = try {
        @Suppress("DEPRECATION") // allNetworks: a NetworkCallback would be needed only to watch changes.
        connectivity.allNetworks.flatMap { network ->
            val caps = connectivity.getNetworkCapabilities(network) ?: return@flatMap emptyList()
            val addresses = connectivity.getLinkProperties(network)?.linkAddresses.orEmpty().map { it.address }
            allowed(caps, addresses)
        }
    } catch (_: RuntimeException) {
        emptyList()
    }

    /** Whether a connection that came in on [local] may be served. Loopback is always allowed. */
    fun allows(local: InetAddress): Boolean = local.isLoopbackAddress || local in addresses()

    companion object {
        /**
         * A VPN first (its capabilities may also name the Wi-Fi or cellular network under it): only its Tailscale
         * addresses. Then Wi-Fi and Ethernet: all addresses. Anything else (cellular) none.
         */
        fun allowed(caps: NetworkCapabilities, addresses: List<InetAddress>): List<InetAddress> = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> addresses.filter(LocalAddresses::isTailscale)

            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> addresses

            else -> emptyList()
        }
    }
}
