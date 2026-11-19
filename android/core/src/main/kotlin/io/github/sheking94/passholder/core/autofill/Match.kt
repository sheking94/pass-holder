package io.github.sheking94.passholder.core.autofill

import io.github.sheking94.passholder.core.WebAddress
import io.github.sheking94.passholder.core.parseWebAddress
import io.github.sheking94.passholder.core.transfer.POLISH_COLLATOR

enum class MatchKind { EXACT, SUBDOMAIN }

data class MatchCandidate(val name: String, val urls: List<String>)

data class AppCandidate(val name: String, val urls: List<String>, val androidApps: List<String>)

private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")

private fun parse(raw: String): WebAddress? = parseWebAddress(raw, assumeHttps = true)

private fun isExactOnlyHost(host: String): Boolean = host == "localhost" || host.startsWith("[") || IPV4.matches(host)

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
    if (!page.host.endsWith(".${saved.host}")) return null
    // Only within one registrable domain (review V3-S2): a saved `github.io` or `co.uk` is not a parent of other owners.
    val site = registrableDomain(page.host) ?: return null
    return if (saved.host == site || saved.host.endsWith(".$site")) MatchKind.SUBDOMAIN else null
}

/**
 * Items whose best saved address matches the page: exact host first, then subdomains, each group sorted by name.
 * [exactOnly] leaves out subdomain matches (review V3-S2), for updating a saved login.
 */
fun <T> matchLogins(pageUrl: String, items: List<T>, exactOnly: Boolean = false, candidate: (T) -> MatchCandidate): List<T> {
    class Hit(val item: T, val name: String, val rank: Int)
    val hits = mutableListOf<Hit>()
    for (item in items) {
        val (name, urls) = candidate(item)
        var rank = Int.MAX_VALUE
        for (url in urls) {
            when (matchUrl(pageUrl, url)) {
                MatchKind.EXACT -> rank = 0
                MatchKind.SUBDOMAIN -> if (!exactOnly) rank = minOf(rank, 1)
                null -> {}
            }
        }
        if (rank != Int.MAX_VALUE) hits += Hit(item, name, rank)
    }
    return hits.sortedWith(compareBy<Hit> { it.rank }.thenComparator { a, b -> POLISH_COLLATOR.compare(a.name, b.name) })
        .map { it.item }
}

/**
 * Scheme of the page a browser reports; none (Android 8.0-8.1, or a browser that does not say) counts as `http`, so
 * such a page gets neither `https` logins nor cards (review V3-N5).
 */
fun pageScheme(request: AppRequest): String = request.webScheme?.lowercase() ?: "http"

/**
 * Logins for an app (spec 3.2). The web domain counts only for a browser verified by its certificate, so an app
 * cannot pose as a site; otherwise only logins assigned to the package match, and only if the app is signed with the
 * certificate remembered for the package ([verifyApp]). [exactOnly] as in [matchLogins].
 */
fun <T> matchApp(request: AppRequest, items: List<T>, exactOnly: Boolean = false, candidate: (T) -> AppCandidate): List<T> {
    val domain = request.webDomain
    if (request.browserVerified && !domain.isNullOrEmpty()) {
        return matchLogins("${pageScheme(request)}://$domain", items, exactOnly) {
            candidate(it).let { c -> MatchCandidate(c.name, c.urls) }
        }
    }
    if (!request.appVerified) return emptyList()
    return items.map { it to candidate(it) }
        .filter { request.packageName in it.second.androidApps }
        .sortedWith { a, b -> POLISH_COLLATOR.compare(a.second.name, b.second.name) }
        .map { it.first }
}
