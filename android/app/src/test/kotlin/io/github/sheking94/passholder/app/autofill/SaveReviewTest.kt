package io.github.sheking94.passholder.app.autofill

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.TestSecretWrapper
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.save.SaveDecision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class SaveReviewTest {
    private val app = ApplicationProvider.getApplicationContext<PassHolderApp>()

    @Before
    fun setUp() {
        app.secretWrapper = TestSecretWrapper
        app.phoneStore.disconnect()
        app.phoneStore.createVault("haslo-glowne-1")
    }

    private fun browser(domain: String) = AppRequest("com.android.chrome", domain, "https")
    private fun review(data: SaveData, label: String = "Chrome") = SaveReview(data, app.phoneStore.entries(), label)
    private fun addGithub() = app.phoneStore.upsertContent(
        "1", EntryContentV3("GitHub", "", LoginFields("jkowalski", "s3cret", urls = listOf("https://github.com")), emptyList()),
    )

    @Test
    fun `a new login is titled as new and named after the host`() {
        val review = review(SaveData(browser("www.github.com"), "jan", "pw"))
        val draft = review.initialDraft()
        assertEquals(SaveDraft("github.com", "jan", "pw"), draft)
        assertEquals(SaveDecision.Create, review.decision(draft))
        assertEquals("Nowy login", review.title(draft))
        assertTrue(review.createsEntry(draft))
        assertEquals("Strona: github.com", review.place)
    }

    @Test
    fun `a new app login is named after the app`() {
        val review = review(SaveData(AppRequest("com.example.bank", null, null), "jan", "pw"), label = "Bank")
        assertEquals("Bank", review.initialDraft().name)
        assertEquals("Aplikacja: Bank (com.example.bank)", review.place)
    }

    @Test
    fun `a changed password is titled with the entry name`() {
        addGithub()
        val review = review(SaveData(browser("github.com"), "jkowalski", "new"))
        val draft = review.initialDraft()
        assertEquals(SaveDecision.Update("1"), review.decision(draft))
        assertEquals("Zmiana hasła: GitHub", review.title(draft))
        assertFalse(review.createsEntry(draft))
    }

    @Test
    fun `editing the username to another one makes a new login`() {
        addGithub()
        val review = review(SaveData(browser("github.com"), "jkowalski", "new"))
        val draft = review.initialDraft().copy(username = "inny")
        assertEquals(SaveDecision.Create, review.decision(draft))
        assertEquals("Nowy login", review.title(draft))
    }

    @Test
    fun `editing to a saved login with its password decides none`() {
        addGithub()
        val review = review(SaveData(browser("github.com"), "inny", "s3cret"))
        val draft = review.initialDraft().copy(username = " JKowalski ")
        assertEquals(SaveDecision.None, review.decision(draft))
        assertEquals("Ten login jest już zapisany", review.title(draft))
    }

    @Test
    fun `an empty password saves nothing but the title still follows the username`() {
        addGithub()
        val review = review(SaveData(browser("github.com"), "jkowalski", "new"))
        val draft = review.initialDraft().copy(password = "")
        assertEquals(SaveDecision.None, review.decision(draft))
        assertEquals("Zmiana hasła: GitHub", review.title(draft))
    }

    @Test
    fun `an empty username is allowed`() {
        val review = review(SaveData(browser("github.com"), "", "pw"))
        val draft = review.initialDraft()
        assertEquals(SaveDecision.Create, review.decision(draft))
        assertEquals(SaveOutcome.SAVED, saveReviewed(app, review, draft))
        assertEquals("", (app.phoneStore.entries().single().content.fields as LoginFields).username)
    }

    @Test
    fun `saving takes the name and login from the review`() {
        val review = review(SaveData(browser("github.com"), "jan", "pw"))
        val draft = SaveDraft("Moje konto", "jan.kowalski", "pw2")
        assertEquals(SaveOutcome.SAVED, saveReviewed(app, review, draft))
        val content = app.phoneStore.entries().single().content
        assertEquals("Moje konto", content.name)
        val fields = content.fields as LoginFields
        assertEquals("jan.kowalski", fields.username)
        assertEquals("pw2", fields.password)
        assertEquals(listOf("github.com"), fields.urls)
    }

    @Test
    fun `a blank name falls back to the default one`() {
        val review = review(SaveData(browser("github.com"), "jan", "pw"))
        saveReviewed(app, review, review.initialDraft().copy(name = "  "))
        assertEquals("github.com", app.phoneStore.entries().single().content.name)
    }

    @Test
    fun `saving a changed password updates only the password`() {
        addGithub()
        val review = review(SaveData(browser("github.com"), "jkowalski", "new"))
        assertEquals(SaveOutcome.UPDATED, saveReviewed(app, review, review.initialDraft().copy(password = "newer")))
        val entry = app.phoneStore.entries().single()
        assertEquals("1", entry.id)
        assertEquals(EntryContentV3("GitHub", "", LoginFields("jkowalski", "newer", urls = listOf("https://github.com")), emptyList()), entry.content)
    }

    @Test
    fun `saving reads the vault again and updates a login added after the review started`() {
        val review = review(SaveData(browser("github.com"), "jkowalski", "new"))
        assertEquals(SaveDecision.Create, review.decision(review.initialDraft()))
        addGithub()
        assertEquals(SaveOutcome.UPDATED, saveReviewed(app, review, review.initialDraft()))
        val entry = app.phoneStore.entries().single()
        assertEquals("1", entry.id)
        assertEquals("new", (entry.content.fields as LoginFields).password)
    }

    @Test
    fun `a login saved meanwhile with the same password saves nothing`() {
        val review = review(SaveData(browser("github.com"), "jkowalski", "s3cret"))
        addGithub()
        assertEquals(SaveOutcome.NOTHING, saveReviewed(app, review, review.initialDraft()))
        assertEquals(1, app.phoneStore.entries().size)
    }

    @Test
    fun `an unsaveable address has no target and saves nothing`() {
        val review = review(SaveData(AppRequest("", null, null), "jan", "pw"))
        assertNull(review.target)
        assertEquals(SaveOutcome.NOTHING, saveReviewed(app, review, review.initialDraft()))
        assertTrue(app.phoneStore.entries().isEmpty())
    }

    @Test
    fun `a vault locked meanwhile saves nothing`() {
        val review = review(SaveData(browser("github.com"), "jan", "pw"))
        app.phoneStore.lock()
        assertEquals(SaveOutcome.LOCKED, saveReviewed(app, review, review.initialDraft()))
    }
}
