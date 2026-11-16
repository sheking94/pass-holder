package io.github.sheking94.passholder.app

import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onNodeWithText
import io.github.sheking94.passholder.app.entries.EntryType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsScreenTest : ScreenTestBase() {
    override fun beforeLaunch(app: PassHolderApp) {
        app.settings.lockDelay = true
    }

    @Test
    fun `settings from the menu, back to the list, and a lock on a vault screen ends on Loginy without the form`() {
        val app = androidx.test.core.app.ApplicationProvider.getApplicationContext<PassHolderApp>()
        createVault()
        val vm = viewModel()

        // ⋮ → Ustawienia: the switches live there now, not on the list.
        assertTrue(gone("Blokuj dopiero po 60 s poza aplikacją"))
        menu("Ustawienia")
        waitFor("Blokuj dopiero po 60 s poza aplikacją")
        assertEquals(Screen.Settings, vm.state.value.screen)
        click("Blokuj dopiero po 60 s poza aplikacją")
        waitFor("Sejf blokuje się od razu po wyjściu z aplikacji.")
        assertFalse(app.settings.lockDelay)
        shot("30-ustawienia")
        click("Wróć")
        waitFor("Brak wpisów. Dodaj pierwszy.")
        assertEquals(Screen.List, vm.state.value.screen)

        // System back also returns to the list.
        menu("Ustawienia")
        waitFor("Blokuj dopiero po 60 s poza aplikacją")
        compose.waitForIdle()
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Brak wpisów. Dodaj pierwszy.")

        // Settings locks like every vault screen.
        menu("Ustawienia")
        waitFor("Blokuj dopiero po 60 s poza aplikacją")
        compose.runOnIdle { vm.lock() }
        waitFor("PassHolder jest zablokowany")
        assertTrue(gone("Blokuj dopiero po 60 s"))
        unlock()
        waitFor("Brak wpisów. Dodaj pierwszy.")

        // A half-filled form on another tab, then the vault locks.
        compose.runOnIdle { vm.selectTab(EntryType.CARD) }
        assertEquals(EntryType.CARD, vm.state.value.tab)
        click("+ Dodaj")
        waitFor("Nowa karta")
        type("Nazwa", "Visa firmowa")
        waitFor("Visa firmowa")
        compose.runOnIdle { vm.lock() }
        waitFor("PassHolder jest zablokowany")
        assertTrue(gone("Nowa karta") && gone("Visa firmowa"))
        unlock()
        waitFor("Brak wpisów. Dodaj pierwszy.")
        val state = vm.state.value
        assertEquals(Screen.List, state.screen)
        assertEquals(EntryType.LOGIN, state.tab)
        assertNull(state.status)
        assertNull(state.editing)
        assertTrue(gone("Nowa karta"))

        assertTrue(gone("Visa firmowa"))

        // The forms start empty again: the login form on Loginy, and the card form that was half-filled.
        click("+ Dodaj")
        waitFor("Nowy login")
        assertEquals("", editable("Nazwa"))
        click("Anuluj")
        compose.runOnIdle { vm.selectTab(EntryType.CARD) }
        click("+ Dodaj")
        waitFor("Nowa karta")
        assertEquals("", editable("Nazwa"))
        assertTrue(gone("Visa firmowa"))
    }

    private fun unlock() {
        type("Hasło główne", masterPassword)
        click("Odblokuj")
    }
}

class AskToSaveSettingTest : ScreenTestBase() {
    override fun beforeLaunch(app: PassHolderApp) {
        app.settings.askToSave = true
    }

    @Test
    fun `Pytaj o zapis haseł sits under Autouzupełnianie, is on by default and the click turns it off`() {
        val app = androidx.test.core.app.ApplicationProvider.getApplicationContext<PassHolderApp>()
        createVault()
        menu("Ustawienia")
        waitFor("Pytaj o zapis haseł")
        waitFor("Po zalogowaniu PassHolder zapyta, czy zapisać hasło.")
        val autofillTop = compose.onNodeWithText("Autouzupełnianie").getBoundsInRoot().top
        val saveTop = compose.onNodeWithText("Pytaj o zapis haseł").getBoundsInRoot().top
        assertTrue(saveTop > autofillTop)
        shot("62-ustawienia-zapis")

        click("Pytaj o zapis haseł")
        waitFor("PassHolder nie pyta o zapis.")
        assertFalse(app.settings.askToSave)
        click("Pytaj o zapis haseł")
        waitFor("Po zalogowaniu PassHolder zapyta, czy zapisać hasło.")
        assertTrue(app.settings.askToSave)
    }
}
