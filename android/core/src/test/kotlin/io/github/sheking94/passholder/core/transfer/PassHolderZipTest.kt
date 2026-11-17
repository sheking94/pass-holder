package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.FileChunks
import io.github.sheking94.passholder.core.p2p.EntryCodec
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

class PassHolderZipTest {
    private val notArchive = "Archiwum nie jest eksportem PassHolder"
    private val zipInvalid = "Archiwum ZIP jest uszkodzone albo nieobsługiwane"

    /** Same bodies as core/scripts/transfer-vectors.ts, so a Kotlin export of them matches archive.expected.json. */
    private val text = "Zażółć gęślą jaźń\n".repeat(200).toByteArray(Charsets.UTF_8)
    private val photo = ByteArray(3000).also {
        // JS computes x * 1103515245 in doubles (inexact past 2^53), then ToUint32; done the same way here.
        var x = 1.0
        for (i in it.indices) {
            x = (x * 1103515245.0 + 12345.0) % 4294967296.0
            it[i] = (x.toLong() ushr 24).toByte()
        }
    }
    private val bodies = mapOf("Zażółć ?.txt" to text, "a:b?.jpg" to photo)

    private fun descriptor(name: String, mime: String, n: Int) = Attachment(
        "00000000-0000-4000-8000-00000000000$n",
        name,
        mime,
        bodies.getValue(name).size.toLong(),
        1,
        FileChunks.sha256Hex(bodies.getValue(name)),
        "A".repeat(43) + "=",
    )

    private val login = EntryContent(
        "Bank",
        "Pliki w archiwum",
        LoginFields("jan", "tajne hasło", "", listOf("https://bank.example")),
        emptyList(),
        listOf(descriptor("Zażółć ?.txt", "text/plain", 1), descriptor("a:b?.jpg", "image/jpeg", 2)),
    )
    private val note = EntryContent("Adres", "ul. Polna 1", NoteFields, emptyList())
    private val readAll: (Attachment) -> ByteArray? = { a -> bodies[a.name]?.copyOf() }

    private fun exportBytes(
        entries: List<EntryContent>,
        readFile: (Attachment) -> ByteArray? = readAll,
    ): Pair<ExportedArchive, ByteArray> {
        val out = ByteArrayOutputStream()
        val result = PassHolderZip.export(entries, out, readFile)
        return result to out.toByteArray()
    }

    /** Every file of the archive by path, read with [ArchiveReader]; skips go to [skips]. */
    private fun readAllFiles(zip: ByteArray, skips: MutableMap<String, String> = HashMap()): Pair<ParsedArchive, Map<String, ByteArray>> =
        ArchiveReader(ByteArrayInputStream(zip)).use { r ->
            val parsed = r.readIndex()
            val files = LinkedHashMap<String, ByteArray>()
            r.forEachFile(parsed.entries.flatMap { e -> e.files.map { it.path } }.toSet(), { p, reason -> skips[p] = reason }) { p, b ->
                files[p] = b.copyOf()
            }
            parsed to files
        }

    /** A ZIP written by java.util.zip: deflated entries with data descriptors, unless [stored]. */
    private fun zipOf(vararg files: Pair<String, ByteArray>, stored: Set<String> = emptySet()): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for ((path, body) in files) {
                val e = ZipEntry(path)
                if (path in stored) {
                    e.method = ZipEntry.STORED
                    e.size = body.size.toLong()
                    e.compressedSize = body.size.toLong()
                    e.crc = CRC32().also { it.update(body) }.value
                }
                z.putNextEntry(e)
                z.write(body)
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun index(vararg entries: String) =
        """{"format":"passholder","version":3,"entries":[${entries.joinToString(",")}]}""".toByteArray(Charsets.UTF_8)

    private val bareNote = """"type":"note","name":"Adres","note":"","fields":{},"custom":[]"""
    private val bareLogin =
        """"type":"login","name":"Bank","note":"","fields":{"username":"jan","password":"tajne","totp":"","urls":[],"androidApps":[]},"custom":[]"""
    private fun file(path: String, size: Int = 3, name: String = "a.txt") =
        """{"name":"$name","mime":"text/plain","size":$size,"path":"$path"}"""

    private fun indexOf(bytes: ByteArray, sub: ByteArray, from: Int = 0): Int =
        (from..bytes.size - sub.size).first { i -> sub.indices.all { bytes[i + it] == sub[it] } }

    private fun sha(b: ByteArray) = FileChunks.sha256Hex(b)

    /** archive.expected.json as (content, files with sha256, position). */
    private fun expectedArchive(): List<Triple<EntryContent, List<Pair<ArchivedFile, String>>, Int>> {
        val o = Json.parseToJsonElement(readVector("archive.expected.json")) as JsonObject
        assertEquals(JsonArray(emptyList()), o["skipped"])
        return (o["entries"] as JsonArray).map { item ->
            val e = item as JsonObject
            val files = (e["files"] as JsonArray).map {
                val f = it as JsonObject
                ArchivedFile(
                    f["name"]!!.jsonPrimitive.content,
                    f["mime"]!!.jsonPrimitive.content,
                    f["size"]!!.jsonPrimitive.content.toInt(),
                    f["path"]!!.jsonPrimitive.content,
                ) to f["sha256"]!!.jsonPrimitive.content
            }
            Triple(EntryCodec.parseContent(e["content"]!!), files, e["position"]!!.jsonPrimitive.content.toInt())
        }
    }

    private fun assertMatchesExpected(zip: ByteArray) {
        val (parsed, files) = readAllFiles(zip)
        assertEquals(emptyList<ImportSkip>(), parsed.skipped)
        val actual = parsed.entries.map { e -> Triple(e.content, e.files.map { it to sha(files.getValue(it.path)) }, e.position) }
        assertEquals(expectedArchive(), actual)
    }

    @Test
    fun archivePathNumbersTheFileAndReplacesCharactersWindowsRefuses() {
        assertEquals("files/1-a_b_.jpg", PassHolderZip.archivePath(1, "a:b?.jpg"))
        assertEquals("files/12-_x___y__.txt", PassHolderZip.archivePath(12, "<x>|\"y\"*.txt"))
        assertEquals("files/3-Zażółć.pdf", PassHolderZip.archivePath(3, "Zażółć.pdf"))
    }

    @Test
    fun readsTheSharedArchiveFixtureWrittenByTheExtension() {
        val zip = File(System.getProperty("passholder.repoRoot"), "core/test-vectors/transfer/archive.passholder.zip").readBytes()
        assertMatchesExpected(zip)
    }

    @Test
    fun readsTheArchiveFixtureWrittenByKotlin() {
        val zip = File(System.getProperty("passholder.repoRoot"), "core/test-vectors/transfer/archive-kotlin.passholder.zip").readBytes()
        assertMatchesExpected(zip)
    }

    /** Writes the Kotlin fixture read by core/test/transfer/passholder-zip.test.ts: ./gradlew :core:test -Dpassholder.writeFixtures=true */
    @Test
    fun writesTheKotlinArchiveFixtureWhenAsked() {
        val out = ByteArrayOutputStream()
        // 2026-11-13 12:00 UTC, as in the extension's fixture (ZIP times are local, so the bytes depend on the time zone).
        assertEquals(ExportedArchive(2, 0), PassHolderZip.export(listOf(login, note), out, readAll, 1_794_571_200_000L))
        val zip = out.toByteArray()
        assertMatchesExpected(zip)
        if (System.getProperty("passholder.writeFixtures") == "true") {
            File(System.getProperty("passholder.repoRoot"), "core/test-vectors/transfer/archive-kotlin.passholder.zip").writeBytes(zip)
        }
    }

    @Test
    fun exportWritesTheIndexFirstThenNumberedFilesAndRoundTrips() {
        val (result, zip) = exportBytes(listOf(login, note))
        assertEquals(ExportedArchive(2, 0), result)
        val names = ArrayList<String>()
        var json = ""
        ZipInputStream(ByteArrayInputStream(zip)).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                names.add(e.name)
                assertEquals(ZipEntry.DEFLATED, e.method)
                if (e.name == "passholder.json") json = z.readBytes().toString(Charsets.UTF_8)
            }
        }
        assertEquals(listOf("passholder.json", "files/1-Zażółć _.txt", "files/2-a_b_.jpg"), names)
        assertTrue(json.endsWith("}\n"))
        val doc = Json.parseToJsonElement(json) as JsonObject
        assertEquals(listOf("format", "version", "entries"), doc.keys.toList())
        val entries = doc["entries"] as JsonArray
        assertEquals(listOf("type", "name", "note", "fields", "custom"), (entries[0] as JsonObject).keys.toList())
        val described = (entries[1] as JsonObject)["attachments"] as JsonArray
        for (d in described) assertEquals(listOf("name", "mime", "size", "path"), (d as JsonObject).keys.toList())

        val (parsed, files) = readAllFiles(zip)
        assertEquals(listOf(note, login.copy(attachments = emptyList())), parsed.entries.map { it.content })
        assertEquals(listOf(1, 2), parsed.entries.map { it.position })
        assertEquals(
            listOf(
                ArchivedFile("Zażółć ?.txt", "text/plain", text.size, "files/1-Zażółć _.txt"),
                ArchivedFile("a:b?.jpg", "image/jpeg", photo.size, "files/2-a_b_.jpg"),
            ),
            parsed.entries[1].files,
        )
        assertArrayEquals(text, files.getValue("files/1-Zażółć _.txt"))
        assertArrayEquals(photo, files.getValue("files/2-a_b_.jpg"))
    }

    @Test
    fun exportZeroesFileBytesOnceWritten() {
        val handedOut = ArrayList<ByteArray>()
        exportBytes(listOf(login)) { a -> bodies.getValue(a.name).copyOf().also(handedOut::add) }
        assertTrue(handedOut.isNotEmpty())
        for (b in handedOut) assertTrue(b.all { it == 0.toByte() })
    }

    @Test
    fun exportLeavesOutFilesItCannotReadAndCountsThem() {
        val (some, zip) = exportBytes(listOf(login)) { a -> if (a.name == "a:b?.jpg") null else readAll(a) }
        assertEquals(ExportedArchive(1, 1), some)
        assertEquals(listOf("Zażółć ?.txt"), readAllFiles(zip).first.entries[0].files.map { it.name })

        val (none, bare) = exportBytes(listOf(login)) { null }
        assertEquals(ExportedArchive(0, 2), none)
        val parsed = readAllFiles(bare).first
        assertEquals(listOf(ArchiveEntry(login.copy(attachments = emptyList()), emptyList(), 1)), parsed.entries)
        assertTrue(!bare.toString(Charsets.ISO_8859_1).contains("attachments"))
    }

    @Test
    fun refusesAnArchiveWhoseFirstEntryIsNotTheIndex() {
        val zip = zipOf("files/1-a.txt" to "abc".toByteArray(), "passholder.json" to index("{$bareNote}"))
        val e = assertThrows<IllegalArgumentException> { ArchiveReader(ByteArrayInputStream(zip)).use { it.readIndex() } }
        assertEquals(notArchive, e.message)
    }

    @Test
    fun refusesAnIndexThatIsNotPassHolderJson() {
        val zip = zipOf("passholder.json" to """{"format":"other"}""".toByteArray())
        assertEquals(
            notArchive,
            assertThrows<IllegalArgumentException> {
                ArchiveReader(ByteArrayInputStream(zip)).use { it.readIndex() }
            }.message,
        )
        val empty = zipOf()
        assertEquals(
            notArchive,
            assertThrows<IllegalArgumentException> {
                ArchiveReader(ByteArrayInputStream(empty)).use { it.readIndex() }
            }.message,
        )
    }

    @Test
    fun refusesBytesThatAreNotAZip() {
        val e = assertThrows<IllegalArgumentException> { ArchiveReader(ByteArrayInputStream("{}".toByteArray())).use { it.readIndex() } }
        assertEquals(zipInvalid, e.message)
    }

    @Test
    fun skipsAFileThatInflatesPastTheLimitWithoutKeepingIt() {
        val zip = zipOf(
            "passholder.json" to
                index("{$bareNote,\"attachments\":[${file("files/1-bomb.bin", 1000, "bomb.bin")},${file("files/2-a.txt")}]}"),
            "files/1-bomb.bin" to ByteArray(11 * 1024 * 1024),
            "files/2-a.txt" to "abc".toByteArray(),
        )
        val skips = HashMap<String, String>()
        val (_, files) = readAllFiles(zip, skips)
        assertEquals(mapOf("files/1-bomb.bin" to "inny rozmiar niż w opisie"), skips)
        assertEquals(setOf("files/2-a.txt"), files.keys)
    }

    @Test
    fun refusesAnArchiveThatWouldInflateFarPastTheFileLimitToFindAnEntryEnd() {
        // 80 MiB of zeros with a data descriptor: its end is only found by inflating, which stops 64 MiB past 10 MiB.
        val zip = zipOf("passholder.json" to index("{$bareNote}"), "files/1-bomb.bin" to ByteArray(80 * 1024 * 1024))
        val e = assertThrows<IllegalArgumentException> {
            ArchiveReader(ByteArrayInputStream(zip)).use { r ->
                r.readIndex()
                r.forEachFile(emptySet()) { _, _ -> }
            }
        }
        assertEquals(zipInvalid, e.message)
    }

    private fun readThrough(zip: ByteArray) = ArchiveReader(ByteArrayInputStream(zip)).use { r ->
        r.readIndex()
        r.forEachFile(emptySet()) { _, _ -> }
    }

    @Test
    fun boundsTheInflatingByWhatTheIndexDescribes() {
        // Eight 9 MiB entries of zeros with data descriptors: each under the file limit, 72 MiB in all.
        val zeros = ByteArray(9 * 1024 * 1024)
        val paths = (1..8).map { "files/$it-z.bin" }
        val undescribed = zipOf("passholder.json" to index("{$bareNote}"), *paths.map { it to zeros }.toTypedArray())
        assertEquals(zipInvalid, assertThrows<IllegalArgumentException> { readThrough(undescribed) }.message)
        // Described with their sizes, the same entries are an ordinary archive (even when no file is wanted).
        val described = index("{$bareNote,\"attachments\":[${paths.joinToString(",") { file(it, zeros.size, "z.bin") }}]}")
        readThrough(zipOf("passholder.json" to described, *paths.map { it to zeros }.toTypedArray()))
    }

    @Test
    fun refusesAnEntryNameOverTheLengthLimit() {
        readThrough(zipOf("passholder.json" to index("{$bareNote}"), "x".repeat(1024) to "a".toByteArray()))
        val zip = zipOf("passholder.json" to index("{$bareNote}"), "x".repeat(1025) to "a".toByteArray())
        assertEquals(zipInvalid, assertThrows<IllegalArgumentException> { readThrough(zip) }.message)
    }

    @Test
    fun skipsAFileWhoseHeaderDeclaresMoreThanTheLimitWithoutInflatingIt() {
        // Deflated with the sizes in the local header (no data descriptor), as the extension writes.
        val body = ByteArray(11 * 1024 * 1024)
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            z.putNextEntry(ZipEntry("passholder.json"))
            z.write(index("{$bareNote,\"attachments\":[${file("files/1-big.bin", 1000, "big.bin")},${file("files/2-a.txt")}]}"))
            val e = ZipEntry("files/1-big.bin")
            val deflater = Deflater(Deflater.DEFAULT_COMPRESSION, true)
            deflater.setInput(body)
            deflater.finish()
            val buf = ByteArray(65536)
            var csize = 0L
            while (!deflater.finished()) csize += deflater.deflate(buf)
            deflater.end()
            e.size = body.size.toLong()
            e.compressedSize = csize
            e.crc = CRC32().also { it.update(body) }.value
            z.putNextEntry(e)
            z.write(body)
            z.putNextEntry(ZipEntry("files/2-a.txt"))
            z.write("abc".toByteArray())
        }
        val skips = HashMap<String, String>()
        val (_, files) = readAllFiles(out.toByteArray(), skips)
        assertEquals(mapOf("files/1-big.bin" to "inny rozmiar niż w opisie"), skips)
        assertEquals(setOf("files/2-a.txt"), files.keys)
    }

    @Test
    fun skipsAFileWithABadCrcAndReadsTheNextOne() {
        val stored = setOf("files/1-a.txt")
        val zip = zipOf(
            "passholder.json" to index("{$bareNote,\"attachments\":[${file("files/1-a.txt", 5)},${file("files/2-b.txt", 3, "b.txt")}]}"),
            "files/1-a.txt" to "hello".toByteArray(),
            "files/2-b.txt" to "abc".toByteArray(),
            stored = stored,
        )
        zip[indexOf(zip, "hello".toByteArray()) + 4] = 'p'.code.toByte()
        val skips = HashMap<String, String>()
        val (_, files) = readAllFiles(zip, skips)
        assertEquals(mapOf("files/1-a.txt" to "uszkodzony"), skips)
        assertArrayEquals("abc".toByteArray(), files["files/2-b.txt"])
    }

    @Test
    fun refusesAnEncryptedEntryAndARepeatedName() {
        val base = zipOf(
            "passholder.json" to index("{$bareNote,\"attachments\":[${file("files/1-a.txt")}]}"),
            "files/1-a.txt" to "abc".toByteArray(),
            "files/2-a.txt" to "abc".toByteArray(),
        )
        val wanted = setOf("files/1-a.txt")
        val encrypted = base.copyOf()
        val second = indexOf(encrypted, "files/1-a.txt".toByteArray()) - 30
        encrypted[second + 6] = (encrypted[second + 6].toInt() or 1).toByte()
        val repeated = base.copyOf()
        val third = indexOf(repeated, "files/2-a.txt".toByteArray())
        repeated[third + 6] = '1'.code.toByte()
        for (zip in listOf(encrypted, repeated)) {
            val e = assertThrows<IllegalArgumentException> {
                ArchiveReader(ByteArrayInputStream(zip)).use { r ->
                    r.readIndex()
                    r.forEachFile(wanted) { _, _ -> }
                }
            }
            assertEquals(zipInvalid, e.message)
        }
    }

    @Test
    fun refusesAnArchiveOverTheSizeLimit() {
        val (_, zip) = exportBytes(listOf(login, note))
        val e = assertThrows<IllegalArgumentException> {
            ArchiveReader(ByteArrayInputStream(zip), zip.size - 1L).use { r ->
                val parsed = r.readIndex()
                r.forEachFile(parsed.entries.flatMap { x -> x.files.map { it.path } }.toSet()) { _, _ -> }
            }
        }
        assertEquals("Plik jest za duży (limit 256 MiB)", e.message)
        ArchiveReader(ByteArrayInputStream(zip), zip.size.toLong()).use { r ->
            r.readIndex()
            r.forEachFile(emptySet()) { _, _ -> }
        }
        assertEquals(268435456L, PassHolderZip.MAX_ZIP_BYTES)
    }

    private fun fixture(name: String) = File(System.getProperty("passholder.repoRoot"), "core/test-vectors/transfer/$name").readBytes()

    private fun assertInvalid(zip: ByteArray) = assertEquals(
        zipInvalid,
        assertThrows<IllegalArgumentException> {
            readThrough(zip)
        }.message,
    )

    @Test
    fun refusesAnArchiveWhoseEndIsCutShortOrFollowedByMoreBytes() {
        for (zip in listOf(
            fixture("archive.passholder.zip"),
            fixture("archive-kotlin.passholder.zip"),
            exportBytes(listOf(login, note)).second,
        )) {
            readThrough(zip)
            for (cut in listOf(1, 5, 22, 30)) assertInvalid(zip.copyOf(zip.size - cut))
            assertInvalid(zip + byteArrayOf(0))
            // Cut before the central directory: the entries are whole, the end is missing.
            val directory = indexOf(zip, byteArrayOf(0x50, 0x4b, 0x01, 0x02))
            assertInvalid(zip.copyOf(directory))
        }
    }

    @Test
    fun acceptsAnArchiveCommentAndRefusesAnInconsistentEndRecord() {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            z.setComment("komentarz")
            z.putNextEntry(ZipEntry("passholder.json"))
            z.write(index("{$bareNote}"))
            z.putNextEntry(ZipEntry("files/1-a.txt"))
            z.write("abc".toByteArray())
        }
        val zip = out.toByteArray()
        readThrough(zip)
        val end = indexOf(zip, byteArrayOf(0x50, 0x4b, 0x05, 0x06))
        fun patched(at: Int, value: Int) = zip.copyOf().also { it[end + at] = value.toByte() }
        assertInvalid(patched(4, 1)) // disk number: several disks
        assertInvalid(patched(6, 1)) // disk of the central directory
        assertInvalid(patched(8, 1)) // entries on this disk
        assertInvalid(patched(10, 1)) // entries in all: not the two met
        assertInvalid(patched(12, zip[end + 12] + 1)) // directory size
        assertInvalid(patched(16, zip[end + 16] + 1)) // directory offset
        assertInvalid(patched(20, 3)) // comment shorter than the bytes left
        // A central record naming an entry that was not met.
        val central = indexOf(zip, "files/1-a.txt".toByteArray(), indexOf(zip, byteArrayOf(0x50, 0x4b, 0x01, 0x02)))
        assertInvalid(zip.copyOf().also { it[central + 6] = '2'.code.toByte() })
    }

    // ---- parseIndex: the same cases as parseArchiveIndex in core/test/transfer/passholder-zip.test.ts ----

    private fun parse(vararg entries: String) = PassHolderZip.parseIndex(index(*entries).toString(Charsets.UTF_8))
    private val noteContent = EntryContent("Adres", "", NoteFields, emptyList())
    private val loginContent = EntryContent("Bank", "", LoginFields("jan", "tajne"), emptyList())
    private val a = ArchivedFile("a.txt", "text/plain", 3, "files/1-a.txt")

    @Test
    fun parseIndexKeepsEntriesWithAndWithoutFiles() {
        assertEquals(
            ParsedArchive(listOf(ArchiveEntry(noteContent, listOf(a), 1), ArchiveEntry(loginContent, emptyList(), 2)), emptyList()),
            parse("{$bareNote,\"attachments\":[${file("files/1-a.txt")}]}", "{$bareLogin}"),
        )
    }

    @Test
    fun parseIndexSkipsAnEntryWithABadFileDescription() {
        fun bad(attachments: String) = "{$bareNote,\"attachments\":$attachments}"
        val many = { n: Int -> (1..n).joinToString(",", "[", "]") { file("files/$it-a.txt") } }
        val r = parse(
            bad("""[{"name":"a.txt","mime":"text/plain","size":3,"path":"files/1-a.txt","key":"x"}]"""),
            bad(many(41)),
            bad("[]"),
            bad("[${file("files/1-a.txt", 0)}]"),
            bad("""[{"name":"a/b","mime":"text/plain","size":3,"path":"files/1-a.txt"}]"""),
            bad("[${file("")}]"),
            bad(many(40)),
        )
        assertEquals((1..6).map { ImportSkip("wpis $it", "zły format wpisu") }, r.skipped)
        assertEquals(1, r.entries.size)
        assertEquals(40, r.entries[0].files.size)
        assertEquals(7, r.entries[0].position)
    }

    @Test
    fun parseIndexGivesEachEntryItsPositionCountingSkippedOnes() {
        val r = parse(
            """{$bareNote,"attachments":[{"name":"a.txt","mime":"text/plain","size":3,"path":"files/1-a.txt","key":"x"}]}""",
            "{$bareLogin}",
            "{$bareNote,\"attachments\":[${file("files/1-a.txt")}]}",
        )
        assertEquals(listOf(ImportSkip("wpis 1", "zły format wpisu")), r.skipped)
        assertEquals(listOf(2, 3), r.entries.map { it.position })
    }

    @Test
    fun parseIndexSkipsALaterEntryThatDescribesAPathAlreadyDescribed() {
        val f = file("files/1-a.txt")
        val other = file("files/2-b.txt")
        val r = parse(
            "{$bareNote,\"attachments\":[$f]}",
            "{$bareLogin,\"attachments\":[$other,$f]}",
            """{"type":"note","name":"Dwa razy","note":"","fields":{},"custom":[],"attachments":[$other,$other]}""",
            """{"type":"note","name":"Drugi","note":"","fields":{},"custom":[],"attachments":[$other]}""",
        )
        assertEquals(listOf(2, 3).map { ImportSkip("wpis $it", "zły format wpisu") }, r.skipped)
        assertEquals(
            listOf(1 to listOf("files/1-a.txt"), 4 to listOf("files/2-b.txt")),
            r.entries.map { e ->
                e.position to
                    e.files.map { it.path }
            },
        )
    }

    @Test
    fun parseIndexFollowsThePassHolderJsonRulesForTheRest() {
        assertEquals(
            listOf(ImportSkip("wpis 1", "brak nazwy")),
            parse("""{"type":"note","name":" ","note":"","fields":{},"custom":[]}""").skipped,
        )
        assertEquals(
            listOf(ImportSkip("wpis 1", "zły format wpisu")),
            parse("""{$bareNote,"extra":1}""").skipped,
        )
        assertEquals(
            "To nie jest plik PassHolder w wersji 3",
            assertThrows<IllegalArgumentException> { PassHolderZip.parseIndex("{") }.message,
        )
    }
}
