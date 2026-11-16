package io.github.sheking94.passholder.core.save

import io.github.sheking94.passholder.core.autofill.parse

// Port of core/src/save/url.ts.

/** Address to save a login under for a page (spec 3.1), or null when the page cannot be saved. */
fun saveUrl(pageUrl: String): String? {
    val parsed = parse(pageUrl, wwwBeforeDot = true) ?: return null
    val hostPort = if (parsed.port.isEmpty()) parsed.host else "${parsed.host}:${parsed.port}"
    return if (parsed.https) hostPort else "http://$hostPort"
}

/** Host of a [saveUrl] result without scheme and port. */
fun saveName(url: String): String {
    val rest = url.removePrefix("https://").removePrefix("http://")
    val end = if (rest.startsWith("[")) rest.indexOf(']') + 1 else rest.indexOf(':')
    return if (end > 0) rest.substring(0, end) else rest
}
