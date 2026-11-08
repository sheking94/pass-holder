package io.github.sheking94.passholder.app

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.Assert.assertEquals
import org.junit.Test

/** Picking an installed app for a login; the same app picked twice is added once. */
class AppPickerScreenTest : ScreenTestBase() {
    override fun beforeLaunch(app: PassHolderApp) {
        app.installedApps = InstalledApps {
            listOf(InstalledApp("mBank", "pl.mbank"), InstalledApp("Allegro", "pl.allegro"))
        }
    }

    @Test
    fun `an app picked from the installed list is saved once`() {
        createVault()
        click("+ Dodaj")
        waitFor("Nowy login")
        type("Nazwa", "mBank")
        type("Hasło", "s3cret-haslo")
        click("+ Wybierz aplikację")
        waitFor("Allegro")
        type("Szukaj…", "mb")
        compose.waitForIdle()
        assertEquals(0, compose.onAllNodes(hasText("Allegro")).fetchSemanticsNodes().size)
        shot("42-wybor-aplikacji")
        pick()
        waitFor("mBank · pl.mbank")

        click("+ Wybierz aplikację")
        waitFor("Allegro")
        type("Szukaj…", "xyz")
        waitFor("Nic nie pasuje.")
        type("Szukaj…", "mb")
        pick()
        compose.waitForIdle()
        assertEquals(1, compose.onAllNodes(hasText("mBank · pl.mbank")).fetchSemanticsNodes().size)

        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val store = ApplicationProvider.getApplicationContext<PassHolderApp>().phoneStore
        assertEquals(listOf("pl.mbank"), (store.entry(store.entries().single().id)!!.content.fields as LoginFields).androidApps)
    }

    /** The "mBank / pl.mbank" row of the picker (its own text, not the list row "mBank · pl.mbank"). */
    private fun pick() = compose.onNode(hasText("pl.mbank") and hasText("mBank")).performClick()
}
