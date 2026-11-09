package io.github.sheking94.passholder.app

import android.content.ClipboardManager
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A new card: number, CVC and PIN are masked, CVC copies as a secret, a bad expiry is refused, a full card saves. */
class EditCardScreenTest : ScreenTestBase() {
    @Test
    fun `a new card keeps its secrets masked, copies the CVC and validates the expiry`() {
        createVault()
        viewModel().selectTab(EntryType.CARD)
        compose.waitForIdle()
        click("+ Dodaj")
        waitFor("Nowa karta")
        type("Nazwa", "Visa")
        type("Posiadacz", "JAN KOWALSKI")
        type("Numer", "4111 1111 1111 1111")
        type("Ważność", "13/27")
        type("CVC", "123")
        type("PIN", "4321")
        compose.waitForIdle()
        for (label in listOf("Numer", "CVC", "PIN")) {
            val node = compose.onAllNodes(hasSetTextAction() and hasText(label))[0].fetchSemanticsNode()
            assertTrue("$label is a password field", node.config.contains(SemanticsProperties.Password))
            assertTrue("$label is masked", editable(label).let { it.isNotEmpty() && it.all { c -> c == '•' } })
        }

        fieldButton("CVC", "Kopiuj").apply { performScrollTo() }.performClick()
        waitFor("Skopiowano CVC. Schowek zostanie wyczyszczony za 1 min.")
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        assertEquals("123", app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString())

        click("Zapisz")
        waitFor("Ważność: wpisz MM/RR")
        assertTrue(app.phoneStore.entries().isEmpty())

        type("Ważność", "12/27")
        compose.waitForIdle()
        assertTrue("the error goes away with the next edit", compose.onAllNodes(hasText("Ważność: wpisz MM/RR")).fetchSemanticsNodes().isEmpty())
        compose.onNode(hasText("Nowa karta")).performScrollTo()
        shot("40-formularz-karta")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        assertEquals(
            EntryContentV3("Visa", "", CardFields("JAN KOWALSKI", "4111 1111 1111 1111", "12/27", "123", "4321"), emptyList()),
            app.phoneStore.entries().single().content,
        )
    }
}
