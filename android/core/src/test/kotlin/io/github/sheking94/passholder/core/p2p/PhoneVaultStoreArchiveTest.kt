package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.assertCode
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.FileChunks
import io.github.sheking94.passholder.core.transfer.ArchiveImportResult
import io.github.sheking94.passholder.core.transfer.ImportSkip
import io.github.sheking94.passholder.core.transfer.PassHolderZip
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class PhoneVaultStoreArchiveTest {
    @TempDir
    lateinit var dir: File

    private lateinit var store: PhoneVaultStore

    private val time = 1_700_000_000_000L
    private val scan = ByteArray(300_000) { (it * 31 % 251).toByte() }
    private val photo = ByteArray(120_000).also { java.util.Random(7).nextBytes(it) }
    private val bodies = mapOf("skan?.pdf" to scan, "zdjęcie.jpg" to photo)

    private fun descriptor(name: String, n: Int) = Attachment(
        "00000000-0000-4000-8000-00000000000$n",
        name,
        "application/octet-stream",
        bodies.getValue(name).size.toLong(),
        1,
        FileChunks.sha256Hex(bodies.getValue(name)),
        "A".repeat(43) + "=",
    )

    private val withFiles = EntryContent(
        "Umowa",
        "z plikami",
        LoginFields("jan", "tajne"),
        emptyList(),
        listOf(descriptor("skan?.pdf", 1), descriptor("zdjęcie.jpg", 2)),
    )
    private val plain = EntryContent("Adres", "ul. Polna 1", NoteFields, emptyList())

    @BeforeEach
    fun createVault() {
        store = PhoneVaultStore(dir, PlainSecretWrapper, { time })
        store.createVault("pw")
    }

    private fun archive(entries: List<EntryContent> = listOf(withFiles, plain)): ByteArray {
        val out = ByteArrayOutputStream()
        PassHolderZip.export(entries, out) { a -> bodies.getValue(a.name).copyOf() }
        return out.toByteArray()
    }

    private fun storedIds(): Set<String> = File(dir, "p2p/files").listFiles().orEmpty().filter { it.isDirectory }.map { it.name }.toSet()

    @Test
    fun importsEntriesAndFilesIntoAnEmptyVault() {
        val (parsed, result) = store.importArchive(ByteArrayInputStream(archive()))
        assertEquals(2, parsed.entries.size)
        assertEquals(ArchiveImportResult(ImportResult(2, 0, 0), 2, emptyList()), result)
        val imported = store.allContents().single { it.name == "Umowa" }
        assertEquals(withFiles.copy(attachments = emptyList()), imported.copy(attachments = emptyList()))
        assertEquals(listOf("skan?.pdf", "zdjęcie.jpg"), imported.attachments.map { it.name })
        for (a in imported.attachments) {
            assertTrue(a.id !in withFiles.attachments.map { it.id })
            assertArrayEquals(bodies.getValue(a.name), store.readFile(a))
        }
        assertEquals(imported.attachments.map { it.id }.toSet(), storedIds())
        assertEquals(emptyList<Attachment>(), store.allContents().single { it.name == "Adres" }.attachments)
    }

    @Test
    fun importingTheSameArchiveAgainAddsNothing() {
        val zip = archive()
        store.importArchive(ByteArrayInputStream(zip))
        val ids = storedIds()
        val contents = store.allContents()
        val (_, again) = store.importArchive(ByteArrayInputStream(zip))
        assertEquals(ArchiveImportResult(ImportResult(0, 2, 0), 0, emptyList()), again)
        assertEquals(ids, storedIds())
        assertEquals(contents.toSet(), store.allContents().toSet())
    }

    @Test
    fun anEntryWhoseFileIsMissingIsImportedWithoutIt() {
        val index = """{"format":"passholder","version":3,"entries":[{"type":"note","name":"Umowa","note":"","fields":{},"custom":[],""" +
            """"attachments":[{"name":"brak.txt","mime":"text/plain","size":3,"path":"files/1-brak.txt"},""" +
            """{"name":"jest.txt","mime":"text/plain","size":3,"path":"files/2-jest.txt"},""" +
            """{"name":"inny.txt","mime":"text/plain","size":9,"path":"files/3-inny.txt"}]}]}"""
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for ((path, body) in listOf("passholder.json" to index, "files/2-jest.txt" to "abc", "files/3-inny.txt" to "abc")) {
                z.putNextEntry(ZipEntry(path))
                z.write(body.toByteArray())
            }
        }
        val (_, result) = store.importArchive(ByteArrayInputStream(out.toByteArray()))
        assertEquals(
            ArchiveImportResult(
                ImportResult(1, 0, 0),
                1,
                listOf(ImportSkip("wpis 1, brak.txt", "brak w archiwum"), ImportSkip("wpis 1, inny.txt", "inny rozmiar niż w opisie")),
            ),
            result,
        )
        val entry = store.allContents().single()
        assertEquals(listOf("jest.txt"), entry.attachments.map { it.name })
        assertArrayEquals("abc".toByteArray(), store.readFile(entry.attachments.single()))
        assertEquals(setOf(entry.attachments.single().id), storedIds())
    }

    @Test
    fun aLaterCopyOfAnEntryRefusedAsTooLargeStillBringsItsFiles() {
        // Same content (files aside); the first copy's 40 file descriptors push it past the entry size limit.
        val head = """"type":"note","name":"Długa","note":"${"x".repeat(45_000)}","fields":{},"custom":[]"""
        fun described(n: Int) = """{"name":"p$n.txt","mime":"text/plain","size":1,"path":"files/$n-p$n.txt"}"""
        val index =
            """{"format":"passholder","version":3,"entries":[{$head,"attachments":[${(1..40).joinToString(",") { described(it) }}]},""" +
                """{$head,"attachments":[${described(41)}]}]}"""
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            z.putNextEntry(ZipEntry("passholder.json"))
            z.write(index.toByteArray())
            for (n in 1..41) {
                z.putNextEntry(ZipEntry("files/$n-p$n.txt"))
                z.write(byteArrayOf(n.toByte()))
            }
        }
        val (_, result) = store.importArchive(ByteArrayInputStream(out.toByteArray()))
        assertEquals(ArchiveImportResult(ImportResult(1, 0, 1), 1, emptyList()), result)
        val entry = store.allContents().single()
        assertEquals(listOf("p41.txt"), entry.attachments.map { it.name })
        assertArrayEquals(byteArrayOf(41), store.readFile(entry.attachments.single()))
        assertEquals(setOf(entry.attachments.single().id), storedIds())
    }

    @Test
    fun anArchiveWhoseEndIsCutShortImportsNothing() {
        store.upsertContent("e1", plain.copy(name = "Było"))
        val before = store.allContents()
        val zip = archive()
        assertCode(ErrorCode.ZIP_INVALID) { store.importArchive(ByteArrayInputStream(zip.copyOf(zip.size - 5))) }
        assertEquals(before, store.allContents())
        assertEquals(emptySet<String>(), storedIds())
    }

    @Test
    fun importsTheFixturesOfBothApps() {
        for (name in listOf("archive.passholder.zip", "archive-kotlin.passholder.zip")) {
            val home = File(dir, name).also { it.mkdirs() }
            val fresh = PhoneVaultStore(home, PlainSecretWrapper, { time }).also { it.createVault("pw") }
            val zip = File(System.getProperty("passholder.repoRoot"), "core/test-vectors/transfer/$name").readBytes()
            val (_, result) = fresh.importArchive(ByteArrayInputStream(zip))
            assertTrue(result.filesAdded > 0 && result.fileSkips.isEmpty(), "$name: $result")
            val files = fresh.allContents().flatMap { it.attachments }
            assertEquals(result.filesAdded, files.size)
            for (a in files) assertEquals(a.size, fresh.readFile(a).size.toLong())
        }
    }

    /** Reads at most 4 KiB per call and runs [onPassed] once [threshold] bytes went through. */
    private class Tripwire(input: InputStream, private val threshold: Int, private val onPassed: () -> Unit) : FilterInputStream(input) {
        private var count = 0
        private var fired = false

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = super.read(b, off, minOf(len, 4096))
            if (n > 0) count += n
            if (!fired && count >= threshold) {
                fired = true
                onPassed()
            }
            return n
        }
    }

    @Test
    fun aVaultLockedDuringTheImportLeavesNoEntriesAndNoFiles() {
        store.upsertContent("e1", plain.copy(name = "Było"))
        val before = store.allContents()
        val zip = archive()
        // The archive ends with the photo (random, so stored about as large): lock while it is being read.
        var filesAtLock = emptySet<String>()
        assertCode(ErrorCode.VAULT_LOCKED) {
            store.importArchive(
                Tripwire(ByteArrayInputStream(zip), zip.size - 20_000) {
                    filesAtLock = storedIds()
                    store.lock()
                },
            )
        }
        store.unlock("pw")
        assertEquals(before, store.allContents())
        assertEquals(1, filesAtLock.size)
        assertEquals(emptySet<String>(), storedIds())
    }
}
