package io.github.sheking94.passholder.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.app.autofill.SaveData
import io.github.sheking94.passholder.app.autofill.SaveOutcome
import io.github.sheking94.passholder.app.autofill.SaveReview
import io.github.sheking94.passholder.app.autofill.saveReviewed
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.FileChunks
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.fakes.BaseCursor
import org.robolectric.Shadows.shadowOf
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

private fun app() = ApplicationProvider.getApplicationContext<PassHolderApp>()
private fun phoneStore(): PhoneVaultStore = app().phoneStore

/** A provider's answer to the query for name and size: one row. */
private class OpenableCursor(private val name: String, private val size: Long?) : BaseCursor() {
    override fun moveToFirst() = true
    override fun getColumnIndex(columnName: String) = when (columnName) {
        OpenableColumns.DISPLAY_NAME -> 0
        OpenableColumns.SIZE -> 1
        else -> -1
    }
    override fun isNull(columnIndex: Int) = columnIndex == 1 && size == null
    override fun getString(columnIndex: Int): String = name
    override fun getLong(columnIndex: Int): Long = size ?: 0L
    override fun close() {}
}

/** The files of the phone's file store: the ids that are on disk. */
private fun filesOnDisk(): List<String> = File(app().filesDir, "p2p/files").list().orEmpty().toList()

/**
 * Attachments through the real form: the system pickers are answered with Robolectric's result delivery, the
 * "provider" is a registered cursor and stream per file.
 */
abstract class AttachmentsScreenBase : ScreenTestBase() {
    protected val out: File = Files.createTempDirectory("attachments").toFile()
    private var next = 0

    /** A content Uri that answers name, size and bytes like a provider; [size] defaults to the real one. */
    protected fun provided(name: String, bytes: ByteArray, size: Long? = bytes.size.toLong()): Uri {
        val uri = Uri.parse("content://test.docs/doc/${next++}")
        val cursor = OpenableCursor(name, size)
        val resolver = shadowOf(app().contentResolver)
        resolver.setCursor(uri, cursor)
        resolver.registerInputStream(uri, ByteArrayInputStream(bytes))
        return uri
    }

    /** The picker launched by the last click is answered with [uri] (null: cancelled). */
    protected fun answerPicker(uri: Uri?) {
        scenario.onActivity { activity ->
            val shadow = shadowOf(activity)
            val request = shadow.peekNextStartedActivityForResult().intent
            if (uri == null) shadow.receiveResult(request, Activity.RESULT_CANCELED, null)
            else shadow.receiveResult(request, Activity.RESULT_OK, Intent().setData(uri))
        }
        compose.waitForIdle()
    }

    /** "+ Dodaj plik" and the picker's answer. */
    protected fun addFile(uri: Uri) {
        click("+ Dodaj plik")
        answerPicker(uri)
    }

    protected fun newNote(name: String) {
        createVault()
        click("Notatki")
        click("+ Dodaj")
        waitFor("Nowa notatka")
        type("Nazwa", name)
    }

    /** Opens the saved note [name] from the list (its row may carry the " 📎 N" clip). */
    protected fun openNote(name: String) {
        click("Notatki")
        compose.onNode(hasText(name).or(hasText("$name 📎", substring = true))).performClick()
        waitFor("Edytuj notatkę")
    }

    protected fun noteWith(name: String, vararg files: Attachment): String =
        putEntry(EntryContentV3(name, "", NoteFields, emptyList(), files.toList()))

    protected fun attachments() = phoneStore().entries().single().content.attachments
}

class AttachmentsAddScreenTest : AttachmentsScreenBase() {
    @Test
    fun `a picked file is a new row, Zapisz keeps it in the entry`() {
        newNote("Dokumenty")
        addFile(provided("dowod.jpg", byteArrayOf(1, 2, 3)))
        waitFor("dowod.jpg")
        waitFor("1 KB · nowy – zapisz wpis")
        compose.onNode(hasText("Pobierz")).performScrollTo().assertIsNotEnabled()
        assertEquals(1, filesOnDisk().size)

        addFile(provided("umowa.pdf", ByteArray(2048) { it.toByte() }))
        waitFor("umowa.pdf")
        waitFor("2 KB · nowy – zapisz wpis")
        compose.onNode(hasText("Załączniki")).performScrollTo()
        shot("43-zalaczniki")

        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val saved = attachments()
        assertEquals(listOf("dowod.jpg", "umowa.pdf"), saved.map { it.name })
        assertTrue(saved.all { phoneStore().isFileComplete(it) })
        assertEquals(2, filesOnDisk().size)
        assertArrayEquals(byteArrayOf(1, 2, 3), phoneStore().readFile(saved[0]))
    }
}

class AttachmentsCancelScreenTest : AttachmentsScreenBase() {
    @Test
    fun `Anuluj after adding a file leaves no entry and no file`() {
        newNote("Dokumenty")
        addFile(provided("dowod.jpg", byteArrayOf(1, 2, 3)))
        waitFor("dowod.jpg")
        assertEquals(1, filesOnDisk().size)
        click("Anuluj")
        waitFor("Brak wpisów. Dodaj pierwszy.")
        compose.waitUntil(10_000) { filesOnDisk().isEmpty() }
        assertTrue(phoneStore().entries().isEmpty())
    }
}

class AttachmentsBackScreenTest : AttachmentsScreenBase() {
    @Test
    fun `Back after adding a file leaves no entry and no file`() {
        newNote("Dokumenty")
        addFile(provided("dowod.jpg", byteArrayOf(1, 2, 3)))
        waitFor("dowod.jpg")
        assertEquals(1, filesOnDisk().size)
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Brak wpisów. Dodaj pierwszy.")
        compose.waitUntil(10_000) { filesOnDisk().isEmpty() }
        assertTrue(phoneStore().entries().isEmpty())
    }
}

class AttachmentsRemoveScreenTest : AttachmentsScreenBase() {
    @Test
    fun `a file removed from the form before Zapisz is deleted from the disk`() {
        newNote("Dokumenty")
        addFile(provided("dowod.jpg", byteArrayOf(1, 2, 3)))
        waitFor("dowod.jpg")
        assertEquals(1, filesOnDisk().size)
        // The form's "Usuń" (the row's), not the entry's: this is a new entry, which has none.
        click("Usuń")
        compose.waitUntil(10_000) { gone("dowod.jpg") }
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        assertTrue(phoneStore().entries().single().content.attachments.isEmpty())
        compose.waitUntil(10_000) { filesOnDisk().isEmpty() }
    }
}

class AttachmentsDuplicateScreenTest : AttachmentsScreenBase() {
    @Test
    fun `the same file twice gives two attachments with different ids`() {
        newNote("Dokumenty")
        val bytes = byteArrayOf(9, 8, 7)
        addFile(provided("kopia.txt", bytes))
        waitFor("kopia.txt")
        addFile(provided("kopia.txt", bytes))
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("kopia.txt")).fetchSemanticsNodes().size == 2 }
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val saved = attachments()
        assertEquals(2, saved.size)
        assertEquals(2, saved.map { it.id }.toSet().size)
        assertEquals(2, filesOnDisk().size)
    }
}

class AttachmentsLimitsScreenTest : AttachmentsScreenBase() {
    @Test
    fun `the 21st file, a file over 10 MB and an empty file are refused`() {
        createVault()
        val store = phoneStore()
        val twenty = (1..20).map { store.addFile(byteArrayOf(it.toByte()), "plik$it.bin", "") }
        val id = noteWith("Pełny", *twenty.toTypedArray())
        openNote("Pełny")
        addFile(provided("jeden-za-duzo.bin", byteArrayOf(1)))
        waitFor("Najwyżej 20 plików we wpisie")
        assertEquals(20, store.entry(id)!!.content.attachments.size)
        assertEquals(20, filesOnDisk().size)
        click("Anuluj")

        click("+ Dodaj")
        waitFor("Nowa notatka")
        type("Nazwa", "Mały")
        val before = filesOnDisk().size
        addFile(provided("duzy.bin", ByteArray(0), size = 10_485_761L))
        waitFor("Plik jest za duży (limit 10 MB)")
        addFile(provided("pusty.bin", ByteArray(0)))
        waitFor("Plik jest pusty")
        assertEquals(before, filesOnDisk().size)
        assertTrue(gone("duzy.bin") && gone("pusty.bin"))
    }
}

class AttachmentsLockedScreenTest : AttachmentsScreenBase() {
    @Test
    fun `a file picked after the vault locked is not read or stored`() {
        newNote("Dokumenty")
        click("+ Dodaj plik")
        phoneStore().lock()
        answerPicker(provided("dowod.jpg", byteArrayOf(1, 2, 3)))
        assertTrue(gone("dowod.jpg"))
        assertTrue(filesOnDisk().isEmpty())
        assertFalse(viewModel().state.value.busy)
    }
}

class AttachmentsDownloadScreenTest : AttachmentsScreenBase() {
    @Test
    fun `Pobierz warns first, Anuluj does nothing, then the file is written with the same bytes`() {
        createVault()
        val bytes = ByteArray(5000) { (it * 7).toByte() }
        val a = phoneStore().addFile(bytes, "dowod.jpg", "image/jpeg")
        noteWith("Skany", a)
        openNote("Skany")
        waitFor("dowod.jpg")
        waitFor("5 KB")
        compose.onNode(hasText("Pobierz")).performScrollTo().assertIsEnabled().performClick()
        waitFor("Pobrać plik?")
        waitFor(AttachmentFilesTexts.WARNING)
        shot("44-pobierz-ostrzezenie")

        compose.onNode(hasText("Anuluj") and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { gone("Pobrać plik?") }
        assertFalse(statusIsSaved(viewModel()))

        compose.onNode(hasText("Pobierz")).performScrollTo().performClick()
        waitFor("Pobrać plik?")
        compose.onAllNodes(hasText("Pobierz"))[1].performClick()
        val target = File(out, "dowod-kopia.jpg")
        answerPicker(Uri.fromFile(target))
        waitFor("Zapisano plik dowod.jpg.")
        assertArrayEquals(bytes, target.readBytes())
    }
}

private fun statusIsSaved(vm: AppViewModel) = vm.state.value.status?.text?.startsWith("Zapisano plik") == true

/** The warning text, written out here so a change to it is noticed. */
private object AttachmentFilesTexts {
    const val WARNING = "Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym urządzeniu."
}

class AttachmentsWaitingScreenTest : AttachmentsScreenBase() {
    @Test
    fun `a file whose chunks are not on the phone waits for the sync and cannot be downloaded`() {
        createVault()
        // Described by an entry (as the extension sends it) but never stored here.
        val missing = FileChunks.encrypt(byteArrayOf(1, 2, 3), "zdalny.pdf", "application/pdf").attachment
        noteWith("Z wtyczki", missing)
        openNote("Z wtyczki")
        waitFor("zdalny.pdf")
        waitFor("1 KB · czeka na synchronizację")
        compose.onNode(hasText("Pobierz")).performScrollTo().assertIsNotEnabled()
    }
}

class AttachmentsCorruptedScreenTest : AttachmentsScreenBase() {
    @Test
    fun `a chunk replaced on the disk gives Plik jest uszkodzony`() {
        createVault()
        val store = phoneStore()
        val a = store.addFile(ByteArray(100) { 1 }, "dowod.jpg", "image/jpeg")
        val other = store.addFile(ByteArray(100) { 2 }, "inny.jpg", "image/jpeg")
        val dir = File(app().filesDir, "p2p/files")
        File(dir, "${other.id}/0").copyTo(File(dir, "${a.id}/0"), overwrite = true)
        noteWith("Skany", a)
        val vm = viewModel()
        val target = File(out, "x.jpg")
        compose.runOnIdle { vm.downloadFile(a, Uri.fromFile(target)) }
        waitFor("Plik jest uszkodzony")
        assertFalse(target.exists() && target.length() > 0)
    }
}

class AttachmentsKeepScreenTest : AttachmentsScreenBase() {
    @Test
    fun `renaming the entry and saving a new password keep the attachments`() {
        createVault()
        val a = phoneStore().addFile(byteArrayOf(1, 2, 3), "dowod.jpg", "image/jpeg")
        val id = noteWith("Skany", a)
        openNote("Skany")
        waitFor("dowod.jpg")
        type("Nazwa", "Skany 2")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        assertEquals(listOf(a), phoneStore().entry(id)!!.content.attachments)
        assertTrue(phoneStore().isFileComplete(a))

        // A login with a file, then the autofill save of a new password (RF 3).
        phoneStore().upsertContent(
            "1",
            EntryContentV3("GitHub", "", LoginFields("jkowalski", "s3cret", urls = listOf("https://github.com")), emptyList(), listOf(a)),
        )
        val review = SaveReview(SaveData(AppRequest("com.android.chrome", "github.com", "https", browserVerified = true), "jkowalski", "nowe"), phoneStore().entries(), "Chrome")
        assertEquals(SaveOutcome.UPDATED, saveReviewed(app(), review, review.initialDraft()))
        assertEquals(listOf(a), phoneStore().entry("1")!!.content.attachments)
    }
}

/** A provider stream that waits until the test lets it read: keeps the app busy ("Szyfruję plik…") for as long as needed. */
private class BlockedStream(bytes: ByteArray, private val release: java.util.concurrent.CountDownLatch) : java.io.InputStream() {
    private val inner = ByteArrayInputStream(bytes)
    override fun read(): Int { release.await(); return inner.read() }
    override fun read(b: ByteArray, off: Int, len: Int): Int { release.await(); return inner.read(b, off, len) }
}

class AttachmentsBackWhileBusyScreenTest : AttachmentsScreenBase() {
    @Test
    fun `Back while a file is being encrypted does nothing, the file stays in the form and Anuluj then discards it`() {
        newNote("Skany")
        val release = java.util.concurrent.CountDownLatch(1)
        val uri = Uri.parse("content://test.docs/doc/blocked")
        shadowOf(app().contentResolver).setCursor(uri, OpenableCursor("dowod.jpg", 3L))
        shadowOf(app().contentResolver).registerInputStream(uri, BlockedStream(byteArrayOf(1, 2, 3), release))
        val vm = viewModel()
        click("+ Dodaj plik")
        answerPicker(uri)
        compose.waitUntil(10_000) { vm.state.value.busy }

        // The system Back and the ViewModel itself are both guarded.
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.runOnIdle { vm.backToList() }
        assertTrue(vm.state.value.screen is Screen.Edit)

        release.countDown()
        waitFor("dowod.jpg")
        assertEquals(1, filesOnDisk().size)
        click("Anuluj")
        waitFor("Brak wpisów. Dodaj pierwszy.")
        compose.waitUntil(10_000) { filesOnDisk().isEmpty() }
    }
}

class AttachmentsDeleteEntryScreenTest : AttachmentsScreenBase() {
    @Test
    fun `deleting an entry discards the files added in its form`() {
        createVault()
        val old = phoneStore().addFile(byteArrayOf(1, 2, 3), "stary.jpg", "image/jpeg")
        noteWith("Skany", old)
        openNote("Skany")
        waitFor("stary.jpg")
        addFile(provided("nowy.jpg", byteArrayOf(4, 5, 6)))
        waitFor("nowy.jpg")
        assertEquals(2, filesOnDisk().size)

        // The entry's own "Usuń" is the last one in the form (the rows' come before it).
        compose.onAllNodes(hasText("Usuń")).onLast().performScrollTo().performClick()
        waitFor("Usunąć wpis?")
        compose.onNode(hasText("Usuń") and hasAnyAncestor(isDialog())).performClick()
        waitFor("Usunięto na telefonie", substring = true)
        compose.waitUntil(10_000) { filesOnDisk() == listOf(old.id) }
    }
}
