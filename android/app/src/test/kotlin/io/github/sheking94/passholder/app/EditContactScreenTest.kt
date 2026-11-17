package io.github.sheking94.passholder.app

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.LabeledValue
import io.github.sheking94.passholder.core.p2p.PostalAddress
import org.junit.Assert.assertEquals
import org.junit.Test

private fun phoneStore() = ApplicationProvider.getApplicationContext<PassHolderApp>().phoneStore

/** A new contact with every section; a second phone left empty is not saved (point 4). */
class EditContactScreenTest : ScreenTestBase() {
    @Test
    fun `a new contact saves its phones, e-mails and address and drops an empty phone`() {
        createVault()
        viewModel().selectTab(EntryType.CONTACT)
        compose.waitForIdle()
        click("+ Dodaj")
        waitFor("Nowy kontakt")
        type("Nazwa", "Jan Kowalski")
        type("Imię", "Jan")
        type("Nazwisko", "Kowalski")
        field("Data urodzenia").performScrollTo()
        compose.waitForIdle()
        type("Data urodzenia", "1990-02-01")
        click("+ Dodaj telefon")
        type("Etykieta telefonu", "komórka")
        type("Telefon", "+48 600 100 200")
        // Left empty: not saved.
        click("+ Dodaj telefon")
        click("+ Dodaj e-mail")
        type("Etykieta e-maila", "praca")
        type("E-mail", "jan@example.com")
        click("+ Dodaj adres")
        type("Etykieta adresu", "dom")
        type("Ulica", "Długa 1")
        type("Kod pocztowy", "00-001")
        type("Miasto", "Warszawa")
        type("Kraj", "Polska")
        compose.onNode(hasText("Nowy kontakt")).performScrollTo()
        shot("39-formularz-kontakt")

        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val store = phoneStore()
        assertEquals(
            EntryContent(
                "Jan Kowalski",
                "",
                ContactFields(
                    "Jan",
                    "Kowalski",
                    "1990-02-01",
                    listOf(LabeledValue("komórka", "+48 600 100 200")),
                    listOf(LabeledValue("praca", "jan@example.com")),
                    listOf(PostalAddress("dom", "Długa 1", "00-001", "Warszawa", "Polska")),
                ),
                emptyList(),
            ),
            store.entries().single().content,
        )
        assertEquals(EntryType.CONTACT, viewModel().state.value.tab)
    }
}

private val foreignDateContact = EntryContent(
    "Ola",
    "",
    ContactFields("Ola", "", "01.02.1990", listOf(LabeledValue("", "123")), emptyList(), emptyList()),
    emptyList(),
)

/** A birth date written differently by the extension saves as it is (point 1). */
class EditContactForeignDateTest : ScreenTestBase() {
    @Test
    fun `a contact with another date format saves without changing the date`() {
        createVault()
        val id = putEntry(foreignDateContact)
        viewModel().selectTab(EntryType.CONTACT)
        waitFor("Ola")
        click("Ola")
        waitFor("Edytuj kontakt")
        type("Imię", "Aleksandra")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val saved = phoneStore().entry(id)!!.content
        assertEquals("01.02.1990", (saved.fields as ContactFields).birthDate)
        assertEquals("Aleksandra", (saved.fields as ContactFields).firstName)
    }
}

/** A changed, impossible date is refused. */
class EditContactBadDateTest : ScreenTestBase() {
    @Test
    fun `a changed impossible birth date shows the error`() {
        createVault()
        putEntry(foreignDateContact)
        viewModel().selectTab(EntryType.CONTACT)
        waitFor("Ola")
        click("Ola")
        waitFor("Edytuj kontakt")
        field("Data urodzenia").performScrollTo()
        type("Data urodzenia", "1990-02-30")
        click("Zapisz")
        waitFor("Data urodzenia: wpisz datę RRRR-MM-DD")
        assertEquals("01.02.1990", (phoneStore().entries().single().content.fields as ContactFields).birthDate)
    }
}
