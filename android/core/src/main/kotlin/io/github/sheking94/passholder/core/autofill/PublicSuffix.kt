package io.github.sheking94.passholder.core.autofill

/** Port of core/src/autofill/psl.ts; the rules come from the same generated list (core/scripts/gen-psl.ts). */
private object PslRules {
    val exact = HashSet<String>()

    /** "*.ck" stored as "ck" */
    val wildcard = HashSet<String>()

    /** "!www.ck" stored as "www.ck" */
    val exception = HashSet<String>()

    init {
        val stream = PslRules::class.java.getResourceAsStream("public_suffix_rules.txt")
            ?: error("public_suffix_rules.txt missing")
        stream.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (rule in lines) {
                when {
                    rule.isEmpty() || rule.startsWith("//") -> {}
                    rule.startsWith("!") -> exception += rule.substring(1)
                    rule.startsWith("*.") -> wildcard += rule.substring(2)
                    else -> exact += rule
                }
            }
        }
    }
}

/**
 * Public suffix of a lowercase ASCII host (Public Suffix List algorithm, unknown TLDs by the default rule "*"):
 * `example.co.uk` -> `co.uk`, `user.github.io` -> `github.io`.
 */
fun publicSuffix(host: String): String {
    val labels = host.split('.')
    // Longest candidate first: the longest matching rule wins, an exception rule cuts its first label.
    for (i in labels.indices) {
        val name = labels.subList(i, labels.size).joinToString(".")
        if (name in PslRules.exception) return labels.subList(i + 1, labels.size).joinToString(".")
        if (name in PslRules.exact) return name
        if (i + 1 < labels.size && labels.subList(i + 1, labels.size).joinToString(".") in PslRules.wildcard) return name
    }
    return labels.last()
}

/** The registrable domain (public suffix plus one label), null when the host is itself a public suffix. */
fun registrableDomain(host: String): String? {
    val suffix = publicSuffix(host)
    if (host == suffix) return null
    return "${host.substring(0, host.length - suffix.length - 1).substringAfterLast('.')}.$suffix"
}
