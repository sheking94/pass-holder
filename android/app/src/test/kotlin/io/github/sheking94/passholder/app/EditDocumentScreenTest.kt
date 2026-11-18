package io.github.sheking94.passholder.app

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.DocumentKind
import io.github.sheking94.passholder.core.p2p.EntryContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A new document: the kind from the dropdown, a bad expiry date refused, then saved. */
class EditDocumentScreenTest : ScreenTestBase() {
    @Test
    fun `a new document saves the picked kind and refuses a bad expiry date`() {
        createVault()
        viewModel().navigation.selectTab(EntryType.DOCUMENT)
        compose.waitForIdle()
        click("+ Dodaj")
        waitFor("Nowy dokument")
        type("Nazwa", "Paszport Jana")
        compose.onNode(hasText("Rodzaj")).apply { performScrollTo() }.performClick()
        waitFor("Paszport")
        compose.onNode(hasText("Paszport") and androidx.compose.ui.test.hasClickAction()).performClick()
        compose.waitForIdle()
        type("Numer", "AB1234567")
        type("Imię i nazwisko", "Jan Kowalski")
        type("Data wydania", "2020-01-15")
        type("Data ważności", "2030-02-30")
        type("Wystawca", "Wojewoda")
        click("Zapisz")
        waitFor("Data ważności: wpisz datę RRRR-MM-DD")
        val store = ApplicationProvider.getApplicationContext<PassHolderApp>().phoneStore
        assertTrue(store.entries().isEmpty())

        type("Data ważności", "2030-01-14")
        compose.onNode(hasText("Nowy dokument")).performScrollTo()
        shot("41-formularz-dokument")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        assertEquals(
            EntryContent(
                "Paszport Jana",
                "",
                DocumentFields(DocumentKind.PASSPORT, "AB1234567", "Jan Kowalski", "2020-01-15", "2030-01-14", "Wojewoda"),
                emptyList(),
            ),
            store.entries().single().content,
        )
    }
}
