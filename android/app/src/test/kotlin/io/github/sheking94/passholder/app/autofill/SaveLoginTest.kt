package io.github.sheking94.passholder.app.autofill

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.TestSecretWrapper
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.p2p.CustomField
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.save.PREVIOUS_PASSWORD_LABEL
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class SaveLoginTest {
    private val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
    private val label = { pkg: String -> if (pkg == "com.example.bank") "Bank" else pkg }

    @Before
    fun setUp() {
        app.secretWrapper = TestSecretWrapper
        app.phoneStore.disconnect()
        app.phoneStore.createVault("haslo-glowne-1")
    }

    private fun browser(domain: String) = AppRequest("com.android.chrome", domain, "https")
    private fun logins() = app.phoneStore.entries().map { it.id to it.content }
    private fun addGithub() = app.phoneStore.upsertContent(
        "1", EntryContentV3("GitHub", "notatka", LoginFields("jkowalski", "s3cret", urls = listOf("https://github.com")), emptyList()),
    )

    @Test
    fun `new login in browser saved under the domain`() {
        assertEquals(SaveOutcome.SAVED, saveLogin(app, SaveData(browser("www.github.com"), "jan", "pw"), label))
        val (_, content) = logins().single()
        val fields = content.fields as LoginFields
        assertEquals("github.com", content.name)
        assertEquals(listOf("github.com"), fields.urls)
        assertEquals("jan", fields.username)
        assertEquals("pw", fields.password)
    }

    @Test
    fun `new login in an app saved under the package`() {
        assertEquals(SaveOutcome.SAVED, saveLogin(app, SaveData(AppRequest("com.example.bank", null, null), "jan", "pw"), label))
        val (_, content) = logins().single()
        assertEquals("Bank", content.name)
        assertEquals(listOf("com.example.bank"), (content.fields as LoginFields).androidApps)
    }

    @Test
    fun `app posing as a site saved under its package`() {
        addGithub()
        val data = SaveData(AppRequest("com.evil.app", "github.com", "https"), "jkowalski", "other")
        assertEquals(SaveOutcome.SAVED, saveLogin(app, data, label))
        val all = logins()
        assertEquals(2, all.size)
        assertEquals("s3cret", (all.first { it.first == "1" }.second.fields as LoginFields).password)
        assertEquals(listOf("com.evil.app"), (all.first { it.first != "1" }.second.fields as LoginFields).androidApps)
    }

    @Test
    fun `changed password updates the matching entry`() {
        addGithub()
        assertEquals(SaveOutcome.UPDATED, saveLogin(app, SaveData(browser("github.com"), " JKowalski ", "new"), label))
        val (id, content) = logins().single()
        assertEquals("1", id)
        // The replaced password stays in the hidden field „Poprzednie hasło” (review V3-S1).
        val previous = listOf(CustomField(PREVIOUS_PASSWORD_LABEL, "s3cret", hidden = true))
        assertEquals(EntryContentV3("GitHub", "notatka", LoginFields("jkowalski", "new", urls = listOf("https://github.com")), previous), content)
    }

    @Test
    fun `same password changes nothing`() {
        addGithub()
        assertEquals(SaveOutcome.NOTHING, saveLogin(app, SaveData(browser("github.com"), "jkowalski", "s3cret"), label))
        assertEquals(1, logins().size)
    }

    @Test
    fun `locked vault saves nothing`() {
        addGithub()
        app.phoneStore.lock()
        assertEquals(SaveOutcome.LOCKED, saveLogin(app, SaveData(browser("github.com"), "jan", "pw"), label))
        app.phoneStore.unlock("haslo-glowne-1")
        assertEquals(1, logins().size)
    }

    @Test
    fun `toast texts`() {
        assertEquals("Zapisano w PassHolder", saveToast(SaveOutcome.SAVED))
        assertEquals("Zaktualizowano hasło w PassHolder", saveToast(SaveOutcome.UPDATED))
        assertNull(saveToast(SaveOutcome.NOTHING))
        assertNull(saveToast(SaveOutcome.LOCKED))
    }
}
