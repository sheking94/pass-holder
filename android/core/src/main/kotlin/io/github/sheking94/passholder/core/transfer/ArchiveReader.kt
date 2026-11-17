package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.files.Attachments
import java.io.Closeable
import java.io.InputStream
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/**
 * Reads a PassHolder ZIP as a stream, one entry at a time, without a copy on disk: [readIndex] first (the archive's
 * first entry must be passholder.json, else [ErrorCode.ZIP_NOT_PASSHOLDER]), then [forEachFile]. Errors are
 * [PassHolderException]s: [ErrorCode.ZIP_TOO_LARGE] once more than the limit was read,
 * [ErrorCode.ZIP_INVALID] for ZIP64, encryption, a method other than stored/deflate, a repeated name, a name over
 * 1024 bytes, more than 5000 entries, broken structure (a central directory or end record included: cut short,
 * inconsistent with the entries, for several disks or followed by more bytes), or inflated output more than
 * [MAX_EXCESS] beyond what the index describes (the declared size of each described file; nothing for an entry it
 * does not describe). Errors of the input stream itself are passed on. [close] closes the input.
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

        /**
         * Inflated output the whole archive may produce beyond what its index describes: past the declared size of
         * a described file, all of an entry the index does not describe. Past it the archive is refused.
         */
        const val MAX_EXCESS = 64L * 1024 * 1024

        /** Longest entry name accepted, in UTF-8 bytes; names are kept to detect repeats. */
        const val MAX_NAME_BYTES = 1024
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

    /** Declared size of every path the index describes. */
    private var declared: Map<String, Long> = emptyMap()

    /** Output the current entry may produce before it counts against [MAX_EXCESS]. */
    private var allowance = 0L
    private var state = State.NEW

    /** Signature that ended the entries ([CENTRAL_SIG] or [END_SIG]) and its offset in the input. */
    private var ending = 0L
    private var endingAt = 0L

    /** The index (first entry). Throws [ErrorCode.ZIP_NOT_PASSHOLDER] when it is missing, too large or not PassHolder JSON v3. */
    fun readIndex(): ParsedArchive {
        check(state == State.NEW) { "Index already read" }
        state = State.INDEX
        val e = nextEntry() ?: throw notArchive()
        if (e.name != PassHolderZip.ARCHIVE_INDEX) throw notArchive()
        allowance = PassHolderZip.MAX_INDEX_BYTES.toLong()
        val bytes = when (val d = readData(e, PassHolderZip.MAX_INDEX_BYTES)) {
            is Data.Bytes -> d.bytes
            Data.Corrupt -> invalid()
            else -> throw notArchive()
        }
        val parsed = try {
            PassHolderZip.parseIndex(Encoding.fromUtf8OrNull(bytes) ?: throw notArchive())
        } catch (e: PassHolderException) {
            if (e.code != ErrorCode.IMPORT_NOT_PASSHOLDER) throw e
            throw notArchive(e)
        } finally {
            bytes.fill(0)
        }
        declared = parsed.entries.flatMap { it.files }.associate { it.path to it.size.toLong() }
        return parsed
    }

    /**
     * Reads the rest of the archive. For each entry whose path is in [wanted], calls [action] with its bytes (zeroed
     * once [action] returns), or [onSkip] with the Polish reason: past [Attachments.MAX_FILE_SIZE] (stopped while
     * inflating) "inny rozmiar niż w opisie" for a path the index describes (as the extension says: no described
     * size is past the limit), else "za duży"; "uszkodzony" for a wrong CRC or size. Other entries are passed
     * over. Wanted paths never met are for the caller to report ("brak w archiwum"). The archive's end is checked
     * last (see [readDirectory]): a caller must not act on what [action] gave it until this returns.
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
            allowance = declared[e.name] ?: 0L
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

                // The index describes no file past the limit, so a described one that passes it has another size.
                Data.TooLarge -> onSkip(e.name, if (e.name in declared) "inny rozmiar niż w opisie" else "za duży")

                Data.Corrupt -> onSkip(e.name, "uszkodzony")

                Data.Skipped -> Unit
            }
        }
        readDirectory()
        state = State.DONE
    }

    override fun close() {
        buf.fill(0)
        inflater.end()
        input.close()
    }

    // ---- Entries ----

    /** The next local header, or null at the central directory (end of the entries; [ending] then holds its signature and offset). */
    private fun nextEntry(): Local? {
        val at = offset()
        when (val sig = u32()) {
            LOCAL_SIG -> Unit

            CENTRAL_SIG, END_SIG -> {
                ending = sig
                endingAt = at
                return null
            }

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
        if (nameLength > MAX_NAME_BYTES) invalid()
        val nameBytes = bytes(nameLength)
        skip(extraLength.toLong())
        val descriptor = flags and FLAG_DESCRIPTOR != 0
        if (flags and FLAG_ENCRYPTED != 0 || (method != 0 && method != 8) || (descriptor && method == 0)) invalid()
        if (csize == MARKER_32 || size == MARKER_32) invalid()
        val name = Encoding.fromUtf8OrNull(nameBytes) ?: invalid()
        if (!names.add(name) || names.size > PassHolderZip.MAX_ZIP_ENTRIES) invalid()
        return Local(name, method, descriptor, crc, csize, size)
    }

    /**
     * The central directory and the end record, after the last entry: one central record for each entry met, with
     * the same names, then an end record for a single disk that counts them, gives the directory's offset and size,
     * and whose comment ends the input exactly. Anything else (cut short, trailing bytes, ZIP64, several disks) is
     * [ErrorCode.ZIP_INVALID], as the extension refuses it.
     */
    private fun readDirectory() {
        val start = endingAt
        var sig = ending
        val seen = HashSet<String>()
        while (sig == CENTRAL_SIG) {
            skip(4) // versions
            val flags = u16()
            val method = u16()
            skip(8) // time, date, CRC
            val csize = u32()
            val size = u32()
            val nameLength = u16()
            val extraLength = u16()
            val commentLength = u16()
            val disk = u16()
            skip(6) // attributes
            val localAt = u32()
            if (nameLength > MAX_NAME_BYTES) invalid()
            val name = Encoding.fromUtf8OrNull(bytes(nameLength)) ?: invalid()
            skip(extraLength.toLong() + commentLength)
            if (flags and FLAG_ENCRYPTED != 0 || (method != 0 && method != 8) || disk != 0) invalid()
            if (csize == MARKER_32 || size == MARKER_32 || localAt == MARKER_32 || localAt >= start) invalid()
            if (name !in names || !seen.add(name)) invalid()
            sig = u32()
        }
        if (sig != END_SIG) invalid()
        val directorySize = offset() - 4 - start
        val disk = u16()
        val directoryDisk = u16()
        val countOnDisk = u16()
        val count = u16()
        val size = u32()
        val at = u32()
        val commentLength = u16()
        if (disk != 0 || directoryDisk != 0 || countOnDisk != count || count != seen.size || seen.size != names.size) invalid()
        if (size != directorySize || at != start) invalid()
        skip(commentLength.toLong())
        if (fill()) invalid()
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
                    val n = inflater.inflate(out, written, out.size - written)
                    spend(written.toLong(), n)
                    written += n
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
     * not kept; the inflating itself is bounded by [spend].
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
                spend(before, n)
                written += n
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

    /** Counts [n] more output bytes of the current entry (after [before]): what passes [allowance] is excess. */
    private fun spend(before: Long, n: Int) {
        val over = before + n - maxOf(before, allowance)
        if (over > 0) {
            excess += over
            if (excess > MAX_EXCESS) invalid()
        }
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
        if (total > maxZipBytes) throw PassHolderException(ErrorCode.ZIP_TOO_LARGE)
        pos = 0
        lim = n
        return true
    }

    /** Offset in the input of the next unread byte. */
    private fun offset(): Long = total - (lim - pos)

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

    private fun invalid(): Nothing = throw PassHolderException(ErrorCode.ZIP_INVALID)

    private fun notArchive(cause: Throwable? = null) =
        PassHolderException(ErrorCode.ZIP_NOT_PASSHOLDER, "Not a PassHolder archive", cause = cause)
}
