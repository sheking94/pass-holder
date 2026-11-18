package io.github.sheking94.passholder.app

import android.net.Uri
import android.os.Looper
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.transfer.TransferFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.nio.file.Files
import java.time.Duration

class TransferScreenTest : ScreenTestBase() {
    private val dir = Files.createTempDirectory("transfer").toFile()

    private fun file(name: String, bytes: ByteArray): Uri = Uri.fromFile(File(dir, name).apply { writeBytes(bytes) })

    @Test
    fun `menu opens Import i eksport, export needs the checkbox, import refuses big and non-UTF-8 files`() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        createVault()
        putEntry(EntryContent("bank.pl", "", LoginFields("jan.kowalski", "s3cret-haslo"), emptyList()))
        waitFor("bank.pl")
        val vm = viewModel()

        menu("Import i eksport")
        waitFor("Import rozpoznaje format sam: PassHolder ZIP, PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.")
        assertEquals(Screen.Transfer, vm.state.value.screen)
        compose.onNodeWithText("Zapisz plik").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText(io.github.sheking94.passholder.app.ui.CSV_WARNING).assertExists()
        shot("50-import-eksport")
        click("Rozumiem, plik będzie zawierał hasła jawnym tekstem")
        compose.onNodeWithText("Zapisz plik").performScrollTo().assertIsEnabled()

        // Cancelled picker: no message.
        compose.runOnIdle { vm.transfer.importFrom(null) }
        compose.waitForIdle()
        assertNull(vm.state.value.status)

        compose.runOnIdle { vm.transfer.importFrom(file("big.json", ByteArray(TransferFiles.MAX_BYTES + 1) { ' '.code.toByte() })) }
        waitFor("Plik jest za duży (limit 10 MiB)")
        compose.runOnIdle {
            vm.transfer.importFrom(file("cp1250.csv", "name,url\nZażółć,https://x.pl\n".toByteArray(charset("windows-1250"))))
        }
        waitFor("Plik nie jest zapisany w UTF-8")

        // Security review V3-N6: no export without the master password, and a wrong one opens no save dialog.
        val exported = file("passholder.json", ByteArray(0))
        compose.runOnIdle { vm.transfer.exportTo(TransferFormat.PASSHOLDER, exported) }
        waitFor("Wpisz hasło główne, żeby zapisać plik.")
        assertEquals(0L, File(dir, "passholder.json").length())
        var dialogs = 0
        compose.runOnIdle { vm.transfer.confirmExport("nie to hasło") { dialogs++ } }
        waitFor("Złe hasło główne")
        assertEquals(0, dialogs)

        // Export, then import the same file: nothing new, the duplicate is reported.
        compose.runOnIdle { vm.transfer.confirmExport(masterPassword) { dialogs++ } }
        // The check resumes on the main looper, which Robolectric runs only when told to.
        compose.waitUntil(60_000) {
            shadowOf(Looper.getMainLooper()).idle()
            dialogs == 1
        }
        compose.runOnIdle { vm.transfer.exportTo(TransferFormat.PASSHOLDER, exported) }
        waitFor("Zapisano plik. Usuń go zaraz po użyciu, zawiera hasła jawnym tekstem.")
        val text = File(dir, "passholder.json").readText()
        assertTrue(text.contains("bank.pl") && text.contains("s3cret-haslo"))
        compose.runOnIdle { vm.transfer.importFrom(exported) }
        waitFor("Dodano 0 wpisów", substring = true)
        assertTrue(vm.state.value.status!!.text.contains("Pominięto 1 takich"))

        // A Bitwarden file adds an entry, and the list shows it.
        val bitwarden =
            """{"encrypted":false,"items":[{"type":1,"name":"poczta.pl",""" +
                """"login":{"username":"jan@poczta.pl","password":"pw"}}]}"""
        compose.runOnIdle { vm.transfer.importFrom(file("bitwarden.json", bitwarden.toByteArray())) }
        waitFor("Dodano 1 wpis (zsynchronizuj, żeby trafiły do wtyczki).", substring = true)
        assertEquals(2, app.phoneStore.entries().size)
        compose.waitUntil(5_000) { vm.state.value.entries.size == 2 }

        click("Wróć do listy")
        waitFor("poczta.pl")
        assertEquals(Screen.List, vm.state.value.screen)
        dir.deleteRecursively()
    }
}

/** Robolectric's clock only moves when told to: this is "the file picker stayed open for [seconds]". */
private fun passTime(seconds: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(seconds))

class FilePickerLockTest : ScreenTestBase() {
    override fun beforeLaunch(app: PassHolderApp) {
        app.settings.lockDelay = false
    }

    @Test
    fun `a file picker gets 60 s even with the delay off, once, and after that the vault locks with a message`() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        createVault()
        val vm = viewModel()
        menu("Import i eksport")
        waitFor("Importuj plik")

        // The picker is another app: the activity stops. Back within 60 s, the vault is still open.
        compose.runOnIdle { vm.transfer.beginFilePick() }
        scenario.moveToState(Lifecycle.State.CREATED)
        passTime(30)
        assertTrue(app.phoneStore.isUnlocked)
        scenario.moveToState(Lifecycle.State.RESUMED)
        compose.runOnIdle { vm.transfer.importFrom(null) }
        waitFor("Importuj plik")
        assertTrue(app.phoneStore.isUnlocked)
        assertNull(vm.state.value.status)

        // The window was for that one picker: leaving now locks at once.
        scenario.moveToState(Lifecycle.State.CREATED)
        assertFalse(app.phoneStore.isUnlocked)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("PassHolder jest zablokowany")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        waitFor("Brak wpisów. Dodaj pierwszy.")

        // The picker stays open for over a minute: locked, and the locked screen says why.
        menu("Import i eksport")
        waitFor("Importuj plik")
        compose.runOnIdle { vm.transfer.beginFilePick() }
        scenario.moveToState(Lifecycle.State.CREATED)
        passTime(61)
        compose.waitUntil(5_000) { !app.phoneStore.isUnlocked }
        scenario.moveToState(Lifecycle.State.RESUMED)
        compose.runOnIdle { vm.transfer.importFrom(null) }
        waitFor("Zablokowano: wybór pliku trwał ponad 60 s")
        waitFor("PassHolder jest zablokowany")
        assertFalse(app.phoneStore.isUnlocked)
    }
}
