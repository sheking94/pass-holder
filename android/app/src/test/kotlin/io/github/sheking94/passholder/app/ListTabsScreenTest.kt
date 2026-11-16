package io.github.sheking94.passholder.app

import androidx.compose.ui.test.performTextReplacement
import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.DocumentKind
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LabeledValue
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields
import org.junit.Assert.assertTrue
import org.junit.Test

class ListTabsScreenTest : ScreenTestBase() {
    // The only text field on the list; its "Szukaj…" hint disappears once something is typed.
    private val search get() = compose.onNode(androidx.compose.ui.test.hasSetTextAction())

    @Test
    fun `tabs show one type each, search is per tab, Dodaj opens a form of the tab's type`() {
        createVault()
        putEntry(EntryContentV3("bank.pl", "", LoginFields("jan", "pw"), emptyList()))
        putEntry(EntryContentV3("Visa", "", CardFields("Jan", "4111111111111234", "", "", ""), emptyList()))
        putEntry(
            EntryContentV3(
                "Ala",
                "",
                ContactFields("Ala", "", "", listOf(LabeledValue("dom", "600 100 200")), emptyList(), emptyList()),
                emptyList(),
            ),
        )
        putEntry(EntryContentV3("Zakupy", "\nmleko\njajka", NoteFields, emptyList()))
        putEntry(EntryContentV3("Paszport Jana", "", DocumentFields(DocumentKind.PASSPORT, "", "", "", "", ""), emptyList()))

        // Logins first, and only logins.
        waitFor("bank.pl")
        assertTrue(gone("Visa") && gone("Ala") && gone("Zakupy") && gone("Paszport Jana"))
        shot("31-zakladka-loginy")

        click("Karty")
        waitFor("•••• 1234")
        assertTrue(gone("bank.pl"))
        shot("32-zakladka-karty")
        search.performTextReplacement("1234")
        waitFor("Visa")
        search.performTextReplacement("zzz")
        waitFor("Nic nie pasuje.")
        search.performTextReplacement("1234")

        // A tab change clears the phrase.
        click("Kontakty")
        waitFor("600 100 200")
        assertTrue(search.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text.isEmpty())
        shot("33-zakladka-kontakty")
        search.performTextReplacement("600")
        waitFor("Ala")

        click("Notatki")
        waitFor("mleko")
        shot("34-zakladka-notatki")
        click("Dokumenty")
        waitFor("Paszport", substring = true)
        shot("35-zakladka-dokumenty")

        // "+ Dodaj" opens a form of the tab's type; Anuluj returns to that tab.
        click("Karty")
        waitFor("Visa")
        click("+ Dodaj")
        waitFor("Nowa karta")
        click("Anuluj")
        waitFor("Visa")
        assertTrue(gone("Nowa karta"))
    }
}
