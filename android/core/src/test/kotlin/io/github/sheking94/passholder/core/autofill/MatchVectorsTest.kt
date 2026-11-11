package io.github.sheking94.passholder.core.autofill

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class MatchVectorsTest {
    @TestFactory
    fun matchUrlVectors(): List<DynamicTest> = readAutofillCases("match.json").mapIndexed { i, c ->
        DynamicTest.dynamicTest("case $i ${c.str("why")}") {
            val expected = if (c["expected"] is JsonNull) null else c.str("expected")
            val actual = when (matchUrl(c.str("page"), c.str("saved"))) {
                MatchKind.EXACT -> "exact"
                MatchKind.SUBDOMAIN -> "subdomain"
                null -> null
            }
            assertEquals(expected, actual)
        }
    }

    @TestFactory
    fun appVectors(): List<DynamicTest> = readAutofillCases("app.json").mapIndexed { i, c ->
        DynamicTest.dynamicTest("case $i ${c.str("why")}") {
            val r = c["request"] as JsonObject
            val request = AppRequest(
                r.str("packageName"),
                r["webDomain"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content,
                r["webScheme"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content,
            )
            val logins = (c["logins"] as JsonArray).map { it as JsonObject }
            val actual = matchApp(request, logins) {
                AppCandidate(
                    it.str("name"),
                    (it["urls"] as JsonArray).map { u -> u.jsonPrimitive.content },
                    (it["androidApps"] as JsonArray).map { a -> a.jsonPrimitive.content },
                )
            }.map { it.str("name") }
            assertEquals((c["expected"] as JsonArray).map { it.jsonPrimitive.content }, actual)
        }
    }

    @Test
    fun matchLoginsRanksExactBeforeSubdomain() {
        val items = listOf("A" to "google.com", "B" to "mail.google.com", "C" to "x.pl")
        val result = matchLogins("https://mail.google.com", items) { MatchCandidate(it.first, listOf(it.second)) }
        assertEquals(listOf("B", "A"), result.map { it.first })
    }

    @Test
    fun upperCaseSharpSAndSigmaFailClosed() {
        // U+1E9E and a word-final capital sigma lowercase to the characters Java's IDNA2003 maps differently
        // from UTS46 (the sigma is final only at the end of the host: Java skips the dot when it looks ahead).
        assertNull(matchUrl("https://STRA\u1E9EE.de", "strasse.de"))
        assertNull(matchUrl("https://\u039A\u0391\u03A3.", "\u03BA\u03B1\u03C3"))
    }

    @Test
    fun adversarialHostsDoNotMatch() {
        val pages = listOf(
            "https://google.com@evil.pl",
            "https://evil.pl\\@google.com",
            "google.com%2eevil.pl",
            "https://evil.pl\t.google.com",
            "https://evil.pl\n.google.com",
            "https://evil.pl\uFF0F.google.com",
            "https://evil.pl\uFF20.google.com",
            "https://evil.pl\uFF05.google.com",
        )
        for (page in pages) assertNull(matchUrl(page, "google.com"), page)
        assertNull(matchUrl("https://stra\u00DFe.de", "strasse.de"))
    }
}
