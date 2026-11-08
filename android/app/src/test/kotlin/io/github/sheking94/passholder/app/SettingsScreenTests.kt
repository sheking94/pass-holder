package io.github.sheking94.passholder.app

import androidx.compose.ui.semantics.SemanticsProperties
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
        // Only the title for now: the typed forms arrive with task 5.
        waitFor("Nowa karta")
        compose.runOnIdle { vm.lock() }
        waitFor("PassHolder jest zablokowany")
        assertTrue(gone("Nowa karta"))
        unlock()
        waitFor("Brak wpisów. Dodaj pierwszy.")
        val state = vm.state.value
        assertEquals(Screen.List, state.screen)
        assertEquals(EntryType.LOGIN, state.tab)
        assertNull(state.status)
        assertNull(state.editing)
        assertTrue(gone("Nowa karta"))

        // The form starts empty again.
        click("+ Dodaj")
        compose.waitForIdle()
        assertEquals("", field("Nazwa serwisu").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
    }

    private fun unlock() {
        type("Hasło główne", masterPassword)
        click("Odblokuj")
    }
}
