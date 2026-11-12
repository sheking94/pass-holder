package io.github.sheking94.passholder.core.autofill

import io.github.sheking94.passholder.core.transfer.POLISH_COLLATOR
import java.net.IDN

enum class MatchKind { EXACT, SUBDOMAIN }

data class MatchCandidate(val name: String, val urls: List<String>)

data class AppRequest(val packageName: String, val webDomain: String?, val webScheme: String?)

data class AppCandidate(val name: String, val urls: List<String>, val androidApps: List<String>)

/** Browsers whose reported web domain is trusted (spec 3.2). */
val TRUSTED_BROWSERS: Set<String> = setOf(
    "com.android.chrome",
    "com.chrome.beta",
    "com.chrome.dev",
    "com.chrome.canary",
    "org.mozilla.firefox",
    "org.mozilla.firefox_beta",
    "org.mozilla.focus",
    "com.microsoft.emmx",
    "com.brave.browser",
    "com.sec.android.app.sbrowser",
    "com.opera.browser",
    "com.duckduckgo.mobile.android",
    "com.vivaldi.browser",
)

internal class ParsedUrl(val https: Boolean, val host: String, val port: String)

private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
private const val FORBIDDEN_HOST_CHARS = "#%/:<>?@[\\]^|"

/** Hand-written stand-in for the WHATWG URL parser, enough for http(s) hosts (java.net.URI rejects e.g. `_`). */
internal fun parse(raw: String, wwwBeforeDot: Boolean = false): ParsedUrl? {
    val text = raw.trim()
    val schemeEnd = text.indexOf("://")
    val scheme = if (schemeEnd >= 0) text.substring(0, schemeEnd).lowercase() else "https"
    if (scheme != "http" && scheme != "https") return null
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
        if (hostPart.any { it.isWhitespace() || it.isISOControl() || it in FORBIDDEN_HOST_CHARS }) return null
        // Java's IDNA2003 maps these differently from WHATWG (UTS46); fail closed. Checked after lowercasing:
        // U+1E9E lowercases to ß and a word-final capital sigma to ς.
        val lowerHost = hostPart.lowercase()
        if (lowerHost.any { it == 'ß' || it == 'ς' || it == '\u200C' || it == '\u200D' }) return null
        val ascii = try {
            IDN.toASCII(lowerHost).lowercase()
        } catch (_: IllegalArgumentException) {
            return null
        }
        // NFKC mapping can yield forbidden characters (e.g. fullwidth slash); punycode output is plain ASCII.
        if (!ascii.all { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '_' || it == '-' }) return null
        rawHost = if (wwwBeforeDot) ascii.removePrefix("www.").removeSuffix(".") else ascii.removeSuffix(".").removePrefix("www.")
    }
    if (rawHost.isEmpty()) return null
    if (rawPort.any { it !in '0'..'9' }) return null
    val https = scheme == "https"
    val port = if (rawPort.isEmpty()) "" else rawPort.toIntOrNull()?.takeIf { it <= 65535 }?.toString() ?: return null
    // WHATWG URL drops the scheme's default port.
    return ParsedUrl(https, rawHost, if (port == (if (https) "443" else "80")) "" else port)
}

private fun isExactOnlyHost(host: String): Boolean =
    host == "localhost" || host.startsWith("[") || IPV4.matches(host)

/** Matches one saved address against a page address (spec 3.1, rules 1-6). */
fun matchUrl(pageUrl: String, savedUrl: String): MatchKind? {
    val page = parse(pageUrl) ?: return null
    val saved = parse(savedUrl) ?: return null

    if (saved.https && !page.https) return null
    if (saved.port == "") {
        if (page.port != "") return null
    } else if (saved.port != page.port.ifEmpty { if (page.https) "443" else "80" }) {
        return null
    }

    if (page.host == saved.host) return MatchKind.EXACT
    if (isExactOnlyHost(saved.host) || isExactOnlyHost(page.host)) return null
    return if (page.host.endsWith(".${saved.host}")) MatchKind.SUBDOMAIN else null
}

/** Items whose best saved address matches the page: exact host first, then subdomains, each group sorted by name. */
fun <T> matchLogins(pageUrl: String, items: List<T>, candidate: (T) -> MatchCandidate): List<T> {
    class Hit(val item: T, val name: String, val rank: Int)
    val hits = mutableListOf<Hit>()
    for (item in items) {
        val (name, urls) = candidate(item)
        var rank = Int.MAX_VALUE
        for (url in urls) {
            when (matchUrl(pageUrl, url)) {
                MatchKind.EXACT -> rank = 0
                MatchKind.SUBDOMAIN -> rank = minOf(rank, 1)
                null -> {}
            }
        }
        if (rank != Int.MAX_VALUE) hits += Hit(item, name, rank)
    }
    return hits.sortedWith(compareBy<Hit> { it.rank }.thenComparator { a, b -> POLISH_COLLATOR.compare(a.name, b.name) })
        .map { it.item }
}

/**
 * Logins for an app (spec 3.2). The web domain counts only for trusted browsers, so an app cannot
 * pose as a site; otherwise only logins assigned to the package match.
 */
fun <T> matchApp(request: AppRequest, items: List<T>, candidate: (T) -> AppCandidate): List<T> {
    val domain = request.webDomain
    if (request.packageName in TRUSTED_BROWSERS && !domain.isNullOrEmpty()) {
        return matchLogins("${request.webScheme ?: "https"}://$domain", items) {
            candidate(it).let { c -> MatchCandidate(c.name, c.urls) }
        }
    }
    return items.map { it to candidate(it) }
        .filter { request.packageName in it.second.androidApps }
        .sortedWith { a, b -> POLISH_COLLATOR.compare(a.second.name, b.second.name) }
        .map { it.first }
}
