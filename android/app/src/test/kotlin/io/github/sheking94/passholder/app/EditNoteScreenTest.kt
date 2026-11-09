package io.github.sheking94.passholder.app

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.app.entries.EntryType
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.NoteFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditNoteScreenTest : ScreenTestBase() {
    @Test
    fun `a note saves its text in note, and Usuń after confirming deletes it and stays on Notatki`() {
        createVault()
        click("Notatki")
        click("+ Dodaj")
        waitFor("Nowa notatka")
        // A note's text is the shell's "Treść": no separate "Notatka".
        assertTrue(compose.onAllNodes(hasText("Notatka")).fetchSemanticsNodes().isEmpty())
        type("Nazwa", "Zakupy")
        type("Treść", "mleko\njajka")
        shot("38-formularz-notatka")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)

        val store = ApplicationProvider.getApplicationContext<PassHolderApp>().phoneStore
        val id = store.entries().single().id
        assertEquals(EntryContentV3("Zakupy", "mleko\njajka", NoteFields, emptyList()), store.entry(id)!!.content)
        val vm = viewModel()
        assertEquals(EntryType.NOTE, vm.state.value.tab)

        click("Zakupy")
        waitFor("Edytuj notatkę")
        click("Usuń")
        waitFor("Usunąć wpis?")
        compose.onAllNodes(hasText("Usuń"))[1].performClick()
        waitFor("Usunięto na telefonie", substring = true)
        assertNull(store.entry(id))
        assertEquals(EntryType.NOTE, vm.state.value.tab)
        waitFor("Brak wpisów. Dodaj pierwszy.")
    }
}
