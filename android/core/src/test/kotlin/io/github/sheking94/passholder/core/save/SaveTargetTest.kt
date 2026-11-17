package io.github.sheking94.passholder.core.save

import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.p2p.CustomField
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class SaveTargetTest {
    private val chrome = "com.android.chrome"

    @Test
    fun trustedBrowserGivesWeb() {
        assertEquals(SaveTarget.Web("github.com"), saveTargetFor(AppRequest(chrome, "www.GitHub.com", "https", browserVerified = true)))
        assertEquals(
            SaveTarget.Web("http://intranet.local"),
            saveTargetFor(AppRequest(chrome, "intranet.local", "http", browserVerified = true)),
        )
        // No reported scheme counts as http (review V3-N5).
        assertEquals(SaveTarget.Web("http://bank.pl"), saveTargetFor(AppRequest(chrome, "bank.pl", null, browserVerified = true)))
    }

    @Test
    fun otherAppsAndMissingDomainGiveApp() {
        assertEquals(SaveTarget.App("com.example.app"), saveTargetFor(AppRequest("com.example.app", "bank.pl", "https")))
        assertEquals(SaveTarget.App(chrome), saveTargetFor(AppRequest(chrome, null, null, browserVerified = true)))
        // V3-S3: a browser package with another certificate saves under its package, never under the claimed site.
        assertEquals(SaveTarget.App(chrome), saveTargetFor(AppRequest(chrome, "bank.pl", "https")))
        assertNull(saveTargetFor(AppRequest("", null, null)))
    }

    @Test
    fun newLoginForWebAndApp() {
        val web = newLogin(SaveTarget.Web("http://a.example:8080"), "Label", "jan", "pw")
        assertEquals(
            EntryContent("a.example", "", LoginFields("jan", "pw", "", listOf("http://a.example:8080"), emptyList()), emptyList()),
            web,
        )
        val app = newLogin(SaveTarget.App("com.example.app"), "Example", "jan", "pw")
        assertEquals(EntryContent("Example", "", LoginFields("jan", "pw", "", emptyList(), listOf("com.example.app")), emptyList()), app)
    }

    @Test
    fun withPasswordKeepsOtherFields() {
        val c = EntryContent(
            "n",
            "note",
            LoginFields("u", "old", "totp", listOf("x.pl"), listOf("a.b")),
            listOf(CustomField("l", "v", true)),
        )
        assertEquals(
            c.copy(
                fields = (c.fields as LoginFields).copy(password = "new"),
                custom = listOf(CustomField("l", "v", true), CustomField(PREVIOUS_PASSWORD_LABEL, "old", true)),
            ),
            withPassword(c, "new"),
        )
    }

    @Test
    fun withPasswordKeepsOnlyTheLatestPrevious() {
        val c = EntryContent("n", "", LoginFields("u", "one", "", emptyList(), emptyList()), emptyList())
        assertEquals(listOf(CustomField(PREVIOUS_PASSWORD_LABEL, "two", true)), withPassword(withPassword(c, "two"), "three").custom)
        assertEquals(emptyList<CustomField>(), withPassword(c, "one").custom)
    }
}
