package io.github.sheking94.passholder.app

import android.content.ClipboardManager
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkManager
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.app.entries.emptyContent
import io.github.sheking94.passholder.core.p2p.CustomField
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A new login with every field of the form, saved and compared with the store. */
class EditLoginScreenTest : ScreenTestBase() {
    @Test
    fun `a new login saves its address, app, TOTP and a hidden custom field`() {
        createVault()
        click("+ Dodaj")
        waitFor("Nowy login")
        type("Nazwa", "  mBank  ")
        type("Login", "jan.kowalski")

        // No password: the form says so and stays open.
        click("Zapisz")
        waitFor("Podaj albo wygeneruj hasło")
        click("Generuj")
        compose.waitForIdle()
        assertEquals(20, editable("Hasło").length)
        type("Hasło", "s3cret-haslo")
        type("TOTP", "JBSWY3DPEHPK3PXP")
        click("+ Dodaj adres")
        type("Adres strony", "https://mbank.pl")
        click("+ Wpisz pakiet")
        // The hint shows in the focused, empty field.
        field("Nazwa pakietu").apply { performScrollTo() }.performClick()
        waitFor("np. pl.mbank")
        type("Nazwa pakietu", "pl.mbank")
        // Left empty: not saved.
        click("+ Dodaj adres")
        type("Notatka", "konto osobiste")
        click("+ Dodaj pole")
        type("Etykieta", "PIN")
        type("Wartość", "1234")
        click("ukryte")
        compose.waitForIdle()
        compose.onNode(hasText("Nowy login")).performScrollTo()
        shot("36-formularz-login")

        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val store = ApplicationProvider.getApplicationContext<PassHolderApp>().phoneStore
        val id = store.entries().single().id
        assertEquals(
            EntryContentV3(
                "mBank",
                "konto osobiste",
                LoginFields("jan.kowalski", "s3cret-haslo", "JBSWY3DPEHPK3PXP", listOf("https://mbank.pl"), listOf("pl.mbank")),
                listOf(CustomField("PIN", "1234", true)),
            ),
            store.entry(id)!!.content,
        )
        assertEquals(EntryType.LOGIN, viewModel().state.value.tab)
    }
}

/** Editing keeps what the form did not touch (point 2); a hidden custom field stays masked until shown (point 3). */
class EditLoginKeepsFieldsTest : ScreenTestBase() {
    @Test
    fun `editing a login keeps its other fields and a hidden custom field opens masked`() {
        createVault()
        val original = EntryContentV3(
            "bank.pl",
            "notatka",
            LoginFields("jan", "stare-haslo", "TOTPSECRET", listOf("https://bank.pl"), listOf("pl.bank")),
            listOf(CustomField("PIN", "4321", true), CustomField("Klient", "123", false)),
        )
        val id = putEntry(original)
        waitFor("bank.pl")
        click("bank.pl")
        waitFor("Edytuj login")

        // The hidden value is masked, the plain one is not (and is no password field at all).
        assertTrue(isPassword(0) && isMasked(0))
        assertFalse(isPassword(1) || isMasked(1))
        fieldButton("Wartość", "Pokaż").apply { performScrollTo() }.performClick()
        compose.waitForIdle()
        assertEquals("4321", editable("Wartość", 0))
        shot("37-pole-ukryte-pokazane")

        fieldButton("Wartość", "Kopiuj").performClick()
        waitFor("Skopiowano PIN. Schowek zostanie wyczyszczony za 1 min.")
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        assertEquals("4321", app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString())
        assertEquals(1, WorkManager.getInstance(app).getWorkInfosForUniqueWork("clear-clipboard").get().size)

        // "ukryte" off: a plain field; on again: masked at once, although it was shown before.
        compose.onAllNodes(hasText("ukryte"))[0].apply { performScrollTo() }.performClick()
        compose.waitForIdle()
        assertFalse(isPassword(0) || isMasked(0))
        // Only Hasło and TOTP keep "Pokaż"/"Ukryj".
        assertEquals(2, compose.onAllNodes(hasText("Pokaż")).fetchSemanticsNodes().size)
        assertTrue(compose.onAllNodes(hasText("Ukryj")).fetchSemanticsNodes().isEmpty())
        compose.onAllNodes(hasText("ukryte"))[0].apply { performScrollTo() }.performClick()
        compose.waitForIdle()
        assertTrue(isPassword(0) && isMasked(0))

        type("Hasło", "nowe-haslo")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val store = app.phoneStore
        assertEquals(
            original.copy(fields = (original.fields as LoginFields).copy(password = "nowe-haslo")),
            store.entry(id)!!.content,
        )

        // A save under this id with another type is refused (the vault keeps the login).
        val vm = viewModel()
        compose.runOnIdle { vm.save(id, emptyContent(EntryType.NOTE).copy(name = "x"), null) }
        waitFor("Ten wpis ma inny typ")
        assertEquals(EntryType.LOGIN, EntryType.of(store.entry(id)!!.content.fields))
    }

    /** A password field (sensitive, password keyboard), shown or not. */
    private fun isPassword(index: Int): Boolean =
        compose.onAllNodes(hasSetTextAction() and hasText("Wartość"))[index].fetchSemanticsNode().config
            .contains(SemanticsProperties.Password)

    /** Shown as dots: the field's text is the masked one, not the value. */
    private fun isMasked(index: Int): Boolean = editable("Wartość", index).let { it.isNotEmpty() && it.all { c -> c == '•' } }
}
