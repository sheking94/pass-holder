package io.github.sheking94.passholder.core.autofill

import io.github.sheking94.passholder.core.transfer.POLISH_COLLATOR
import java.net.IDN

enum class MatchKind { EXACT, SUBDOMAIN }

data class MatchCandidate(val name: String, val urls: List<String>)

/**
 * Who asks for a fill or a save. [packageName], [webDomain] and [webScheme] are what the app's view structure claims;
 * the two flags are what the phone checked against the app's signing certificate (security review V3-S3), see
 * [verifyApp]. Both default to false, so a request nobody checked trusts neither the web domain nor `androidApps`.
 */
data class AppRequest(
    val packageName: String,
    val webDomain: String?,
    val webScheme: String?,
    /** [packageName] is in [TRUSTED_BROWSERS] and signed with one of its certificates: [webDomain] counts. */
    val browserVerified: Boolean = false,
    /** The app is signed with the certificate remembered for [packageName] (or none is remembered yet): `androidApps` count. */
    val appVerified: Boolean = false,
)

data class AppCandidate(val name: String, val urls: List<String>, val androidApps: List<String>)

/**
 * Browsers whose reported web domain is trusted (spec 3.2): package to the SHA-256 digests (lowercase hex) of its
 * release signing certificates. Source: Google's list of privileged browsers for passkeys
 * (gstatic.com/gpm-passkeys-privileged-apps/apps.json, read 2026-11-15); a browser that rotates its key keeps the
 * old certificate in its signing history, so it still matches.
 */
val TRUSTED_BROWSERS: Map<String, Set<String>> = mapOf(
    "com.android.chrome" to setOf("f0fd6c5b410f25cb25c3b53346c8972fae30f8ee7411df910480ad6b2d60db83"),
    "com.chrome.beta" to setOf(
        "da633d34b69e63ae2103b49d53ce052fc5f7f3c53aab94fdc2a208bdfd14249c",
        "3d7a1223019aa39d9ea0e3436ab7c0896bfb4fb679f4de5fe7c23f326c8f994a",
    ),
    "com.chrome.dev" to setOf(
        "9044ee5fee4bbc5e21dd44665431c4eb1f1f71a32716a0bc927bcbb39233cabf",
        "3d7a1223019aa39d9ea0e3436ab7c0896bfb4fb679f4de5fe7c23f326c8f994a",
    ),
    "com.chrome.canary" to setOf("2019dfa1fb23efbf70c5bcd1443c5beab04f3f2ff4366e9ac1e3457639a24cfc"),
    "org.mozilla.firefox" to setOf("a78b62a5165b4494b2fead9e76a280d22d937fee6251aece599446b2ea319b04"),
    "org.mozilla.firefox_beta" to setOf("a78b62a5165b4494b2fead9e76a280d22d937fee6251aece599446b2ea319b04"),
    "org.mozilla.focus" to setOf("6203a473be36d64ee37f87fa500edbc79eab930610ab9b9fa4ca7d5c1f1b4ffc"),
    "com.microsoft.emmx" to setOf("01e1999710a82c2749b4d50c445dc85d670b6136089d0a766a73827c82a1eac9"),
    "com.brave.browser" to setOf("9c2db70513515fdbfbbc585b3edf3d7123d4dc67c94ffd306361c1d79bbf18ac"),
    "com.sec.android.app.sbrowser" to setOf("34df0e7a9f1cf1892e45c056b4973cd81ccf148a4050d11aea4ac5a65f900a42"),
    "com.opera.browser" to setOf("5d6afbf87f652af04647ada0df634cf22370900b164b09d50bd23aa2cb5285b8"),
    "com.duckduckgo.mobile.android" to setOf("bb7bb31c573c46a1da7fc5c528a6acf432108456feec50810c7f33694eb3d2d4"),
    "com.vivaldi.browser" to setOf("e8a78544655ba8c09817f732768f5689b1662ec4b2bc5a0bc0ec138d33ca3d1e"),
)

/**
 * The request with its flags set from the app's certificates (security review V3-S3). [certs]: SHA-256 digests of
 * the package's signing certificates as the phone reads them (including its signing history), null when the package
 * cannot be read; [pinned]: the digests remembered for the package when it was tied to a login, null when none.
 * Trust on first use: a package with nothing remembered yet is trusted if it can be read at all.
 */
fun verifyApp(request: AppRequest, certs: Set<String>?, pinned: Set<String>?): AppRequest {
    val known = TRUSTED_BROWSERS[request.packageName]
    val browser = certs != null && known != null && certs.any { it in known }
    val app = certs != null && (pinned == null || certs.any { it in pinned })
    return request.copy(browserVerified = browser, appVerified = app)
}

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
 * Logins for an app (spec 3.2). The web domain counts only for a browser verified by its certificate, so an app
 * cannot pose as a site; otherwise only logins assigned to the package match, and only if the app is signed with the
 * certificate remembered for the package ([verifyApp]).
 */
fun <T> matchApp(request: AppRequest, items: List<T>, candidate: (T) -> AppCandidate): List<T> {
    val domain = request.webDomain
    if (request.browserVerified && !domain.isNullOrEmpty()) {
        return matchLogins("${request.webScheme ?: "https"}://$domain", items) {
            candidate(it).let { c -> MatchCandidate(c.name, c.urls) }
        }
    }
    if (!request.appVerified) return emptyList()
    return items.map { it to candidate(it) }
        .filter { request.packageName in it.second.androidApps }
        .sortedWith { a, b -> POLISH_COLLATOR.compare(a.second.name, b.second.name) }
        .map { it.first }
}
