package io.github.sheking94.passholder.core

import java.net.IDN

// One normalization of web addresses for autofill matching, saving and import names (review V3 CS5);
// port of core/src/web-address.ts.

/** An http(s) address as PassHolder compares it: [host] as [normalizeHost] gives it, [port] "" for the scheme default. */
internal class WebAddress(val https: Boolean, val host: String, val port: String)

/**
 * Host as PassHolder compares it: lower case, then without a leading "www.", then without one trailing dot. The
 * order matters only for "www.", which becomes "" (no host): the save vectors fix that ("empty host after www removal").
 */
internal fun normalizeHost(host: String): String = host.lowercase().removePrefix("www.").removeSuffix(".")

/**
 * [text] (trimmed) as an http(s) address with a normalized host, or null when it is not one or its host is empty.
 * [assumeHttps]: text without "://" is read as an https address (saved addresses are stored that way).
 */
internal fun parseWebAddress(text: String, assumeHttps: Boolean): WebAddress? {
    val address = parseAuthority(text, assumeHttps) ?: return null
    if (address.scheme != "http" && address.scheme != "https") return null
    val https = address.scheme == "https"
    // WHATWG URL drops the scheme's default port.
    return WebAddress(https, address.host, if (address.port == (if (https) "443" else "80")) "" else address.port)
}

/** Normalized host of any address (any scheme, "https://" assumed without one), or null when it has none. */
internal fun hostOf(text: String): String? = parseAuthority(text, assumeHttps = true)?.host

private class Authority(val scheme: String, val host: String, val port: String)

private const val FORBIDDEN_HOST_CHARS = "#%/:<>?@[\\]^|"

/** Hand-written stand-in for the WHATWG URL parser, enough for http(s) hosts (java.net.URI rejects e.g. `_`). */
private fun parseAuthority(raw: String, assumeHttps: Boolean): Authority? {
    val text = raw.trim()
    val schemeEnd = text.indexOf("://")
    if (schemeEnd < 0 && !assumeHttps) return null
    val scheme = if (schemeEnd >= 0) text.substring(0, schemeEnd).lowercase() else "https"
    val rest = if (schemeEnd >= 0) text.substring(schemeEnd + 3) else text
    var authority = rest.substring(0, rest.indexOfAny(charArrayOf('/', '?', '#', '\\')).let { if (it < 0) rest.length else it })
    authority = authority.substring(authority.lastIndexOf('@') + 1)

    val rawHost: String
    var rawPort = ""
    if (authority.startsWith("[")) {
        val close = authority.indexOf(']')
        if (close < 0) return null
        rawHost = authority.substring(0, close + 1).lowercase()
        val after = authority.substring(close + 1)
        if (after.isNotEmpty()) {
            if (!after.startsWith(":")) return null
            rawPort = after.substring(1)
        }
    } else {
        val colon = authority.indexOf(':')
        val hostPart = if (colon < 0) authority else authority.substring(0, colon)
        if (colon >= 0) rawPort = authority.substring(colon + 1)
        rawHost = asciiHost(hostPart) ?: return null
    }
    val host = normalizeHost(rawHost)
    if (host.isEmpty()) return null
    if (rawPort.any { it !in '0'..'9' }) return null
    val port = if (rawPort.isEmpty()) "" else rawPort.toIntOrNull()?.takeIf { it <= 65535 }?.toString() ?: return null
    return Authority(scheme, host, port)
}

/** A host name as WHATWG URL writes it (lower case, punycode), or null when it would refuse it. */
private fun asciiHost(hostPart: String): String? {
    if (hostPart.any { it.isWhitespace() || it.isISOControl() || it in FORBIDDEN_HOST_CHARS }) return null
    // Java's IDNA2003 maps these differently from WHATWG (UTS46); fail closed. Checked after lowercasing:
    // U+1E9E lowercases to ß and a word-final capital sigma to ς.
    val lowerHost = hostPart.lowercase()
    if (lowerHost.any { it == 'ß' || it == 'ς' || it == '‌' || it == '‍' }) return null
    val ascii = try {
        IDN.toASCII(lowerHost).lowercase()
    } catch (_: IllegalArgumentException) {
        return null
    }
    // NFKC mapping can yield forbidden characters (e.g. fullwidth slash); punycode output is plain ASCII.
    return if (ascii.all { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '_' || it == '-' }) ascii else null
}
