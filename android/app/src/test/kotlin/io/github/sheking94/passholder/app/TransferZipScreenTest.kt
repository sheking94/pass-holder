package io.github.sheking94.passholder.app

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.transfer.ArchiveReader
import io.github.sheking94.passholder.core.transfer.ImportSkip
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.nio.file.Files
import java.util.function.Supplier
import java.util.zip.ZipInputStream

private fun app() = ApplicationProvider.getApplicationContext<PassHolderApp>()

/** The files of the phone's file store: the ids that are on disk. */
private fun filesOnDisk(): List<String> = File(app().filesDir, "p2p/files").list().orEmpty().toList()

/** core/test-vectors/transfer/archive-kotlin.passholder.zip, written by PassHolderZip.export (task 2): two entries, two files. */
private fun kotlinArchive(): ByteArray {
    var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
    while (dir != null && !File(dir, "core/test-vectors").isDirectory) dir = dir.parentFile
    return File(dir!!, "core/test-vectors/transfer/archive-kotlin.passholder.zip").readBytes()
}

private const val ZIP_WARNING =
    "Uwaga: archiwum nie jest zaszyfrowane. Zawiera hasła jawnym tekstem i odszyfrowane pliki. Każdy, kto je zobaczy " +
        "(inny program, kopia zapasowa, folder w chmurze), pozna je wszystkie. Usuń je zaraz po użyciu."

class TransferZipScreenTest : ScreenTestBase() {
    private val dir = Files.createTempDirectory("transfer-zip").toFile()

    @Test
    fun `the ZIP choice swaps the warning, and its export holds the entries and the files that are ready`() {
        createVault()
        val body = "Zażółć gęślą jaźń\n".repeat(100).toByteArray()
        val stored = app().phoneStore.addFile(body.copyOf(), "umowa:2026?.txt", "text/plain")
        // Described but not on the phone (waiting for sync): left out and counted.
        val waiting = Attachment(
            "00000000-0000-4000-8000-000000000009", "skan.pdf", "application/pdf", 10, 1, "0".repeat(64), Encoding.toBase64(ByteArray(32)),
        )
        putEntry(EntryContentV3("bank.pl", "", LoginFields("jan.kowalski", "s3cret-haslo"), emptyList(), listOf(stored, waiting)))
        waitFor("bank.pl 📎 2")
        val vm = viewModel()

        menu("Import i eksport")
        waitFor("Import rozpoznaje format sam: PassHolder ZIP, PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.")
        waitFor("2 pliki nie zostaną wyeksportowane w formatach JSON i CSV. Wybierz PassHolder ZIP, żeby je zabrać.")
        assertTrue(gone(ZIP_WARNING))
        click("PassHolder ZIP (wpisy i pliki)")
        waitFor(ZIP_WARNING)
        assertTrue(gone("Uwaga: plik nie jest zaszyfrowany."))
        click("Rozumiem, plik będzie zawierał hasła jawnym tekstem")
        shot("51-eksport-zip")
        // Back to JSON: the plain file warning again.
        click("PassHolder JSON (wszystko, bez strat)")
        waitFor("Uwaga: plik nie jest zaszyfrowany.", substring = true)
        assertTrue(gone(ZIP_WARNING))

        val target = File(dir, "passholder.zip").apply { writeText("old, longer content that must not survive the export".repeat(200)) }
        compose.runOnIdle { vm.exportArchiveTo(Uri.fromFile(target)) }
        waitFor(
            "Wyeksportowano 1 wpis i 1 plik. Pominięto 1 plik, który czeka na synchronizację albo jest uszkodzony. " +
                "Usuń archiwum, gdy nie będzie już potrzebne.",
        )
        val skips = HashMap<String, String>()
        val read = HashMap<String, ByteArray>()
        val parsed = ArchiveReader(FileInputStream(target)).use { r ->
            r.readIndex().also { p ->
                r.forEachFile(p.entries.flatMap { e -> e.files.map { it.path } }.toSet(), { path, reason -> skips[path] = reason }) { path, b ->
                    read[path] = b.copyOf()
                }
            }
        }
        assertEquals(emptyList<ImportSkip>(), parsed.skipped)
        assertEquals("bank.pl", parsed.entries.single().content.name)
        assertEquals("s3cret-haslo", (parsed.entries.single().content.fields as LoginFields).password)
        val file = parsed.entries.single().files.single()
        assertEquals("umowa:2026?.txt", file.name)
        assertEquals("files/1-umowa_2026_.txt", file.path)
        assertArrayEquals(body, read.getValue(file.path))
        assertEquals(emptyMap<String, String>(), skips)
        // "wt": the archive replaced the old content, nothing of it is left after the ZIP.
        assertFalse(target.readBytes().toString(Charsets.ISO_8859_1).contains("old, longer content"))
        dir.deleteRecursively()
    }
}

class TransferZipImportTest : ScreenTestBase() {
    private val dir = Files.createTempDirectory("transfer-zip").toFile()

    @Test
    fun `an archive brings its files once, a bare passholder json lists them as skipped`() {
        createVault()
        val vm = viewModel()
        menu("Import i eksport")
        waitFor("Importuj plik")
        val zip = Uri.fromFile(File(dir, "archive.zip").apply { writeBytes(kotlinArchive()) })

        compose.runOnIdle { vm.importFrom(zip) }
        waitFor("Dodano 2 wpisy (zsynchronizuj, żeby trafiły do wtyczki). Dodano 2 pliki. Usuń plik z dysku, zawiera hasła jawnym tekstem.")
        val bank = app().phoneStore.allContents().single { it.name == "Bank" }
        assertEquals(listOf("Zażółć ?.txt", "a:b?.jpg"), bank.attachments.map { it.name })
        assertEquals("Zażółć gęślą jaźń\n".repeat(200), app().phoneStore.readFile(bank.attachments[0]).toString(Charsets.UTF_8))
        compose.waitUntil(5_000) { vm.state.value.entries.size == 2 }
        val files = filesOnDisk().sorted()
        assertEquals(2, files.size)

        // The same archive again: nothing new, no orphaned files.
        compose.runOnIdle { vm.importFrom(zip) }
        waitFor(
            "Dodano 0 wpisów (zsynchronizuj, żeby trafiły do wtyczki). " +
                "Pominięto 2 takich, które już są w sejfie lub powtarzają się w pliku. Usuń plik z dysku, zawiera hasła jawnym tekstem.",
        )
        assertEquals(2, app().phoneStore.allContents().size)
        assertEquals(files, filesOnDisk().sorted())

        // passholder.json taken out of the archive: the entries only, the files listed as skipped.
        val index = ZipInputStream(kotlinArchive().inputStream()).use { z -> z.nextEntry; z.readBytes() }
        compose.runOnIdle { vm.importFrom(Uri.fromFile(File(dir, "passholder.json").apply { writeBytes(index) })) }
        waitFor(
            "Pominięto 2 pliki: wpis 2, Zażółć ?.txt: importuj całe archiwum ZIP; wpis 2, a:b?.jpg: importuj całe archiwum ZIP.",
            substring = true,
        )
        assertEquals(files, filesOnDisk().sorted())
        dir.deleteRecursively()
    }
}

class TransferZipLockTest : ScreenTestBase() {
    @Test
    fun `the vault locking in the middle of an archive import leaves no entries and no files`() {
        createVault()
        val vm = viewModel()
        menu("Import i eksport")
        waitFor("Importuj plik")
        var filesWhenLocked = -1
        val uri = Uri.parse("content://test.docs/archive.zip")
        // Handed out in small pieces; once the reader is inside the second file, the vault locks (as the auto-lock would).
        shadowOf(app().contentResolver).registerInputStreamSupplier(uri, Supplier<InputStream> {
            object : FilterInputStream(kotlinArchive().inputStream()) {
                private var position = 0
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    if (position >= 1500 && filesWhenLocked < 0) {
                        filesWhenLocked = filesOnDisk().size
                        app().phoneStore.lock()
                    }
                    return super.read(b, off, minOf(len, 256)).also { if (it > 0) position += it }
                }
            }
        })

        compose.runOnIdle { vm.importFrom(uri) }
        waitFor("PassHolder jest zablokowany")
        // The first file had been stored when the vault locked: it is gone again.
        assertEquals(1, filesWhenLocked)
        assertEquals(emptyList<String>(), filesOnDisk())
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        waitFor("Brak wpisów. Dodaj pierwszy.")
        assertEquals(0, app().phoneStore.allContents().size)
        assertEquals(emptyList<String>(), filesOnDisk())
    }
}
