package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.Attachments
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.EntryV3
import io.github.sheking94.passholder.core.p2p.ImportResult
import java.io.Closeable
import java.io.FilterOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What [PassHolderZip.export] wrote: [files] files in the archive, [missing] left out (waiting for sync, damaged). */
data class ExportedArchive(val files: Int, val missing: Int)

/** What an archive import did: the entries as [ImportResult], the files stored with them and the files left out. */
data class ArchiveImportResult(val entries: ImportResult, val filesAdded: Int, val fileSkips: List<ImportSkip>)

/**
 * PassHolder ZIP: passholder.json (a PassHolder JSON v3 index whose entries describe their files) followed by the
 * decrypted files under files/<n>-<name>; port of core/src/transfer/passholder-zip.ts. Paths from an archive are only
 * used to look entries up in the ZIP, never as file system paths.
 */
object PassHolderZip {
    const val MAX_ZIP_BYTES = 268435456L
    const val ARCHIVE_INDEX = "passholder.json"
    const val NOT_ARCHIVE = "Archiwum nie jest eksportem PassHolder"
    const val ZIP_INVALID = "Archiwum ZIP jest uszkodzone albo nieobsługiwane"
    const val ZIP_TOO_LARGE = "Plik jest za duży (limit 256 MiB)"

    /** Largest passholder.json accepted, after inflating. */
    internal const val MAX_INDEX_BYTES = 10485760

    /** Most entries a readable archive may hold. */
    internal const val MAX_ZIP_ENTRIES = 5000

    private val UNSAFE = Regex("[<>:\"|?*]")

    /** Path of the n-th exported file (from 1); characters Windows refuses in file names become "_". */
    fun archivePath(n: Int, name: String): String = "files/$n-${name.replace(UNSAFE, "_")}"

    /** The index of a PassHolder ZIP; see [PassHolderJson.parseArchiveIndex]. */
    fun parseIndex(text: String): ParsedArchive = PassHolderJson.parseArchiveIndex(text)

    /**
     * Writes the entries (sorted as in the JSON export) and their files to [out], which stays open. [readFile] gives
     * a file's decrypted bytes, or null when the file is not available (waiting for sync, damaged): it is then left
     * out and counted in `missing`. The index goes first, so each file is read twice (once to learn whether it can
     * be read, once to write it) and only one file is in memory at a time; every array [readFile] returns is zeroed.
     */
    fun export(entries: List<EntryContentV3>, out: OutputStream, readFile: (Attachment) -> ByteArray?): ExportedArchive =
        export(entries, out, readFile, System.currentTimeMillis())

    private class Planned(val attachment: Attachment, val path: String, val size: Int)

    internal fun export(entries: List<EntryContentV3>, out: OutputStream, readFile: (Attachment) -> ByteArray?, time: Long): ExportedArchive {
        var numbered = 0
        var missing = 0
        val plan = sortForExport(entries).map { e ->
            e to e.attachments.mapNotNull { a ->
                val bytes = readFile(a)
                if (bytes == null) {
                    missing++
                    null
                } else {
                    val size = bytes.size
                    bytes.fill(0)
                    Planned(a, archivePath(++numbered, a.name), size)
                }
            }
        }
        val index = JsonArray(
            plan.map { (e, files) ->
                val content = EntryV3.contentJson(e)
                if (files.isEmpty()) {
                    content
                } else {
                    val described = files.map {
                        JsonObject(
                            linkedMapOf(
                                "name" to JsonPrimitive(it.attachment.name),
                                "mime" to JsonPrimitive(it.attachment.mime),
                                "size" to JsonPrimitive(it.size),
                                "path" to JsonPrimitive(it.path),
                            ),
                        )
                    }
                    JsonObject(content + ("attachments" to JsonArray(described)))
                }
            },
        )
        val doc = JsonObject(linkedMapOf("format" to JsonPrimitive("passholder"), "version" to JsonPrimitive(3), "entries" to index))
        val json = (JsonText.stringify(doc) + "\n").toByteArray(Charsets.UTF_8)
        var files = 0
        // Closing the ZIP stream frees its deflater; the caller's stream stays open.
        val keepOpen = object : FilterOutputStream(out) {
            override fun write(b: ByteArray, off: Int, len: Int) = out.write(b, off, len)
            override fun close() = flush()
        }
        ZipOutputStream(keepOpen).use { zip ->
            // The index is written first, so a reader that streams the archive (the phone) meets it before the files.
            zip.putNextEntry(ZipEntry(ARCHIVE_INDEX).also { it.time = time })
            try {
                zip.write(json)
            } finally {
                json.fill(0)
            }
            zip.closeEntry()
            for (f in plan.flatMap { it.second }) {
                // Unavailable since the first pass: the index already describes it, the import reports it missing.
                val bytes = readFile(f.attachment) ?: run {
                    missing++
                    null
                } ?: continue
                try {
                    zip.putNextEntry(ZipEntry(f.path).also { it.time = time })
                    zip.write(bytes)
                    zip.closeEntry()
                } finally {
                    bytes.fill(0)
                }
                files++
            }
        }
        return ExportedArchive(files, missing)
    }
}

/**
 * Reads a PassHolder ZIP as a stream, one entry at a time, without a copy on disk: [readIndex] first (the archive's
 * first entry must be passholder.json, else [PassHolderZip.NOT_ARCHIVE]), then [forEachFile]. Errors are
 * IllegalArgumentExceptions with the Polish message: [PassHolderZip.ZIP_TOO_LARGE] once more than the limit was read,
 * [PassHolderZip.ZIP_INVALID] for ZIP64, encryption, a method other than stored/deflate, a repeated name, more than
 * 5000 entries or broken structure. Errors of the input stream itself are passed on. [close] closes the input.
 */
class ArchiveReader internal constructor(private val input: InputStream, private val maxZipBytes: Long) : Closeable {
    constructor(input: InputStream) : this(input, PassHolderZip.MAX_ZIP_BYTES)

    private companion object {
        const val LOCAL_SIG = 0x04034b50L
        const val CENTRAL_SIG = 0x02014b50L
        const val END_SIG = 0x06054b50L
        const val DESCRIPTOR_SIG = 0x08074b50L
        const val FLAG_ENCRYPTED = 0x0001
        const val FLAG_DESCRIPTOR = 0x0008
        const val MARKER_32 = 0xffffffffL

        /** Output past [Attachments.MAX_FILE_SIZE] an archive may make the reader inflate to find entry ends. */
        const val MAX_EXCESS = 64L * 1024 * 1024
    }

    private class Local(val name: String, val method: Int, val descriptor: Boolean, val crc: Long, val csize: Long, val size: Long)

    private sealed interface Data {
        class Bytes(val bytes: ByteArray) : Data
        data object TooLarge : Data
        data object Corrupt : Data
        data object Skipped : Data
    }

    private enum class State { NEW, INDEX, FILES, DONE }

    private val buf = ByteArray(65536)
    private var pos = 0
    private var lim = 0
    private var total = 0L
    private val inflater = Inflater(true)
    private val names = HashSet<String>()
    private var excess = 0L
    private var state = State.NEW

    /** The index (first entry). Throws [PassHolderZip.NOT_ARCHIVE] when it is missing, too large or not PassHolder JSON v3. */
    fun readIndex(): ParsedArchive {
        check(state == State.NEW) { "Index already read" }
        state = State.INDEX
        val e = nextEntry() ?: throw IllegalArgumentException(PassHolderZip.NOT_ARCHIVE)
        if (e.name != PassHolderZip.ARCHIVE_INDEX) throw IllegalArgumentException(PassHolderZip.NOT_ARCHIVE)
        val bytes = when (val d = readData(e, PassHolderZip.MAX_INDEX_BYTES)) {
            is Data.Bytes -> d.bytes
            Data.Corrupt -> invalid()
            else -> throw IllegalArgumentException(PassHolderZip.NOT_ARCHIVE)
        }
        return try {
            PassHolderZip.parseIndex(strictUtf8(bytes) ?: throw IllegalArgumentException(PassHolderZip.NOT_ARCHIVE))
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException(PassHolderZip.NOT_ARCHIVE)
        } finally {
            bytes.fill(0)
        }
    }

    /**
     * Reads the rest of the archive. For each entry whose path is in [wanted], calls [action] with its bytes (zeroed
     * once [action] returns), or [onSkip] with the Polish reason: "za duży" (past [Attachments.MAX_FILE_SIZE], stopped
     * while inflating) or "uszkodzony" (wrong CRC or size). Other entries are passed over. Wanted paths never met are
     * for the caller to report ("brak w archiwum").
     */
    fun forEachFile(
        wanted: Set<String>,
        onSkip: (path: String, reason: String) -> Unit = { _, _ -> },
        action: (path: String, bytes: ByteArray) -> Unit,
    ) {
        check(state == State.INDEX) { "Read the index first" }
        state = State.FILES
        while (true) {
            val e = nextEntry() ?: break
            if (e.name !in wanted) {
                readData(e, null)
                continue
            }
            when (val d = readData(e, Attachments.MAX_FILE_SIZE)) {
                is Data.Bytes -> try {
                    action(e.name, d.bytes)
                } finally {
                    d.bytes.fill(0)
                }
                Data.TooLarge -> onSkip(e.name, "za duży")
                Data.Corrupt -> onSkip(e.name, "uszkodzony")
                Data.Skipped -> Unit
            }
        }
        // The central directory is not needed, but counts towards the archive's size.
        while (fill()) pos = lim
        state = State.DONE
    }

    override fun close() {
        buf.fill(0)
        inflater.end()
        input.close()
    }

    // ---- Entries ----

    /** The next local header, or null at the central directory (end of the entries). */
    private fun nextEntry(): Local? {
        when (u32()) {
            LOCAL_SIG -> Unit
            CENTRAL_SIG, END_SIG -> return null
            else -> invalid()
        }
        skip(2)
        val flags = u16()
        val method = u16()
        skip(4)
        val crc = u32()
        val csize = u32()
        val size = u32()
        val nameLength = u16()
        val extraLength = u16()
        val nameBytes = bytes(nameLength)
        skip(extraLength.toLong())
        val descriptor = flags and FLAG_DESCRIPTOR != 0
        if (flags and FLAG_ENCRYPTED != 0 || (method != 0 && method != 8) || (descriptor && method == 0)) invalid()
        if (csize == MARKER_32 || size == MARKER_32) invalid()
        val name = strictUtf8(nameBytes) ?: invalid()
        if (!names.add(name) || names.size > PassHolderZip.MAX_ZIP_ENTRIES) invalid()
        return Local(name, method, descriptor, crc, csize, size)
    }

    /** The entry's data: its bytes when [limit] is given and not passed, else read past ([limit] null: [Data.Skipped]). */
    private fun readData(e: Local, limit: Int?): Data = when {
        e.method == 0 -> readStored(e, limit)
        e.descriptor -> inflateUntilEnd(e, limit)
        else -> inflateKnown(e, limit)
    }

    private fun readStored(e: Local, limit: Int?): Data {
        if (e.csize != e.size) invalid()
        if (limit == null || e.size > limit) {
            skip(e.csize)
            return if (limit == null) Data.Skipped else Data.TooLarge
        }
        val out = bytes(e.size.toInt())
        return checked(out, e.crc)
    }

    /** Deflated with the sizes in the local header: the compressed data can be passed over without inflating it. */
    private fun inflateKnown(e: Local, limit: Int?): Data {
        if (limit == null || e.size > limit) {
            skip(e.csize)
            return if (limit == null) Data.Skipped else Data.TooLarge
        }
        val out = ByteArray(e.size.toInt())
        var written = 0
        var left = e.csize
        var corrupt = false
        inflater.reset()
        try {
            while (!inflater.finished()) {
                if (inflater.needsInput()) {
                    if (left == 0L || !fill()) {
                        corrupt = true
                        break
                    }
                    val take = minOf(left, (lim - pos).toLong()).toInt()
                    inflater.setInput(buf, pos, take)
                    pos += take
                    left -= take
                }
                if (written == out.size) {
                    // More output than declared: a probe byte tells.
                    if (inflater.inflate(ByteArray(1)) > 0) {
                        corrupt = true
                        break
                    }
                } else {
                    written += inflater.inflate(out, written, out.size - written)
                }
                if (inflater.needsDictionary()) {
                    corrupt = true
                    break
                }
            }
        } catch (_: DataFormatException) {
            corrupt = true
        }
        skip(left)
        if (corrupt || written != out.size) {
            out.fill(0)
            return Data.Corrupt
        }
        return checked(out, e.crc)
    }

    /**
     * Deflated with a data descriptor (java.util.zip): the end is only known once inflated. Output past [limit] is
     * not kept; output past [Attachments.MAX_FILE_SIZE] (no PassHolder archive has such an entry) is limited to
     * [MAX_EXCESS] over the whole archive, after which the archive is refused.
     */
    private fun inflateUntilEnd(e: Local, limit: Int?): Data {
        var out = ByteArray(if (limit == null) 0 else minOf(limit, 65536))
        val scratch = ByteArray(65536)
        var written = 0L
        var tooLarge = false
        val crc = CRC32()
        inflater.reset()
        try {
            while (!inflater.finished()) {
                if (inflater.needsInput()) {
                    if (!fill()) invalid()
                    inflater.setInput(buf, pos, lim - pos)
                    pos = lim
                }
                val n = inflater.inflate(scratch)
                if (n == 0 && inflater.needsDictionary()) invalid()
                if (n == 0) continue
                val before = written
                written += n
                val over = written - maxOf(before, Attachments.MAX_FILE_SIZE.toLong())
                if (over > 0) {
                    excess += over
                    if (excess > MAX_EXCESS) invalid()
                }
                if (limit == null || tooLarge) continue
                if (written > limit) {
                    tooLarge = true
                    out.fill(0)
                    continue
                }
                if (written > out.size) out = grow(out, minOf(limit.toLong(), maxOf(written, out.size * 2L)).toInt())
                scratch.copyInto(out, before.toInt(), 0, n)
                crc.update(scratch, 0, n)
            }
        } catch (_: DataFormatException) {
            invalid()
        } finally {
            scratch.fill(0)
        }
        // Give back what the inflater did not use: it belongs to the data descriptor.
        pos -= inflater.remaining
        val first = u32()
        val storedCrc = if (first == DESCRIPTOR_SIG) u32() else first
        val csize = u32()
        val size = u32()
        if (limit == null) return Data.Skipped
        if (tooLarge) return Data.TooLarge
        val bytes = if (out.size == written.toInt()) out else out.copyOf(written.toInt()).also { out.fill(0) }
        if (csize != inflater.bytesRead and MARKER_32 || size != written || storedCrc != crc.value) {
            bytes.fill(0)
            return Data.Corrupt
        }
        return Data.Bytes(bytes)
    }

    private fun grow(old: ByteArray, size: Int): ByteArray = old.copyOf(size).also { old.fill(0) }

    private fun checked(out: ByteArray, expected: Long): Data {
        val crc = CRC32().also { it.update(out) }.value
        if (crc != expected) {
            out.fill(0)
            return Data.Corrupt
        }
        return Data.Bytes(out)
    }

    // ---- Input ----

    /** True when unread bytes are buffered; reads more when needed. Counts every byte taken from the input. */
    private fun fill(): Boolean {
        if (pos < lim) return true
        val n = input.read(buf, 0, buf.size)
        if (n <= 0) return false
        total += n
        if (total > maxZipBytes) throw IllegalArgumentException(PassHolderZip.ZIP_TOO_LARGE)
        pos = 0
        lim = n
        return true
    }

    private fun u8(): Int {
        if (!fill()) invalid()
        return buf[pos++].toInt() and 0xff
    }

    private fun u16(): Int = u8() or (u8() shl 8)

    private fun u32(): Long = u16().toLong() or (u16().toLong() shl 16)

    private fun bytes(n: Int): ByteArray {
        val out = ByteArray(n)
        var at = 0
        while (at < n) {
            if (!fill()) invalid()
            val take = minOf(n - at, lim - pos)
            buf.copyInto(out, at, pos, pos + take)
            pos += take
            at += take
        }
        return out
    }

    private fun skip(n: Long) {
        var left = n
        while (left > 0) {
            if (!fill()) invalid()
            val take = minOf(left, (lim - pos).toLong()).toInt()
            pos += take
            left -= take
        }
    }

    private fun strictUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        null
    }

    private fun invalid(): Nothing = throw IllegalArgumentException(PassHolderZip.ZIP_INVALID)
}
