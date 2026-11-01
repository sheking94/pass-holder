package io.github.sheking94.passholder.core

import java.net.URI

/**
 * One server, several addresses: e.g. the home network IP and the Tailscale IP of the same Raspberry Pi.
 * The counterpart of extension/src/server-urls.ts. All addresses share one certificate pin, so a new
 * address can be added without pairing again: whatever answers there must present the same certificate.
 */
object ServerPicker {
    /**
     * How long the quick status check of one address may take before the next one is tried. Without it an
     * address that is not reachable from here (the home IP when you are out, the Tailscale IP with the VPN
     * off) would hold the sync for the full connect and read timeouts.
     */
    const val PROBE_TIMEOUT_MS = 4_000L

    /** Trims, drops trailing slashes, empty entries and duplicates; keeps the order they were typed in. */
    fun normalize(urls: List<String>): List<String> =
        urls.map { it.trim().trimEnd('/') }.filter { it.isNotEmpty() }.distinct()

    /**
     * [normalize]s and checks that every address is a full address with the scheme the pairing used:
     * https:// ([https], with a certificate pin), http:// only for the local development server without one.
     */
    fun validate(urls: List<String>, https: Boolean): List<String> {
        val result = normalize(urls)
        require(result.isNotEmpty()) { "Podaj adres serwera" }
        val scheme = if (https) "https" else "http"
        for (url in result) {
            val uri = runCatching { URI(url) }.getOrNull()
            require(uri != null && uri.scheme == scheme && !uri.host.isNullOrEmpty()) { "Podaj pełny adres, np. $scheme://passholder.local:8443 (był: $url)" }
        }
        return result
    }

    /** The address that worked last time goes first, the others follow in the order they were entered. */
    fun order(urls: List<String>, lastWorking: String?): List<String> =
        if (lastWorking == null || lastWorking !in urls) urls else listOf(lastWorking) + urls.filter { it != lastWorking }

    /**
     * Finds an address at which the server answers and returns it with a client for it. With one address
     * there is nothing to choose, so it is returned without a check (the request itself reports if the
     * server is down). With more, each one gets a short GET /status in turn and the first that answers wins.
     * If none does and one of them presented a different certificate, that error is reported, because it
     * says more than "not reachable".
     */
    fun pick(urls: List<String>, lastWorking: String?, makeClient: (String) -> ServerClient): Pair<String, ServerClient> {
        val ordered = order(urls, lastWorking)
        require(ordered.isNotEmpty()) { "Brak adresu serwera" }
        if (ordered.size == 1) return ordered[0] to makeClient(ordered[0])
        var pinError: Exception? = null
        for (url in ordered) {
            val client = makeClient(url)
            try {
                client.status(PROBE_TIMEOUT_MS)
                return url to client
            } catch (e: Exception) {
                // Not reachable from here (or not our server); try the next address.
                val isPinMismatch = generateSequence(e as Throwable) { it.cause }.any { it is PinMismatchException }
                if (isPinMismatch && pinError == null) pinError = e
            }
        }
        throw pinError ?: ApiException(
            0,
            "Serwer nie odpowiada pod żadnym adresem (${ordered.joinToString(", ")}). " +
                "Czy Raspberry Pi jest włączone? Spoza domu potrzebny jest też włączony Tailscale.",
        )
    }
}
