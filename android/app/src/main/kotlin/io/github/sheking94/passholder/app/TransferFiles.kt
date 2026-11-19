package io.github.sheking94.passholder.app

import android.content.ContentResolver
import android.net.Uri
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.MIB
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.transfer.TransferFormat
import kotlinx.coroutines.CancellationException
import java.io.BufferedOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.time.LocalDate

/**
 * The file side of "Import i eksport": the documents the system file picker returned. Kept out of the screens
 * and the ViewModel so the limits can be tested on bytes.
 */
object TransferFiles {
    /** The largest import file read; one byte more is refused without reading the rest. */
    const val MAX_BYTES = 10 * MIB

    val TOO_LARGE = "Plik jest za duży (limit ${MAX_BYTES / MIB} MiB)"
    const val NOT_UTF8 = "Plik nie jest zapisany w UTF-8"

    const val READ_FAILED = "Nie udało się odczytać pliku."
    const val WRITE_FAILED = "Nie udało się zapisać pliku. Jeśli plik powstał, usuń go, bo może zawierać hasła."

    /** The text of the import file at [uri]: at most [MAX_BYTES], strict UTF-8. */
    fun readText(resolver: ContentResolver, uri: Uri): String = readText { resolver.openInputStream(uri) }

    /** Provider failures (IOException, SecurityException, null stream) become the Polish [READ_FAILED]; the size and UTF-8 messages stay. */
    internal fun readText(open: () -> InputStream?): String {
        val bytes = readFailing {
            val input = open() ?: throw IOException("no stream")
            input.use { readCapped(it) }
        }
        return decode(bytes)
    }

    /** Reads at most [MAX_BYTES] + 1 bytes; the extra byte means the file is too large. */
    fun readCapped(input: InputStream): ByteArray {
        val bytes = ProviderStreams.readCapped(input, MAX_BYTES)
        if (bytes.size > MAX_BYTES) throw IllegalArgumentException(TOO_LARGE)
        return bytes
    }

    /** UTF-8 that refuses malformed bytes instead of replacing them (a Windows-1250 file would import garbled names). */
    fun decode(bytes: ByteArray): String = Encoding.fromUtf8OrNull(bytes) ?: throw IllegalArgumentException(NOT_UTF8)

    /** Writes [text] as UTF-8 over the whole document at [uri] ("wt": an existing file is truncated, not overwritten in part). */
    fun writeText(resolver: ContentResolver, uri: Uri, text: String) = writeText(text) { resolver.openOutputStream(uri, "wt") }

    /** Provider failures (IOException, SecurityException, null stream) become the Polish [WRITE_FAILED]. */
    internal fun writeText(text: String, open: () -> OutputStream?) {
        ProviderStreams.failingAs(WRITE_FAILED) {
            val output = open() ?: throw IOException("no stream")
            output.use { it.write(text.toByteArray(Charsets.UTF_8)) }
        }
    }

    /** The name the save dialog suggests for a text export: passholder-RRRR-MM-DD.json, .csv for NordPass. */
    fun defaultFileName(format: TransferFormat, day: LocalDate = LocalDate.now()): String =
        "passholder-$day.${if (format == TransferFormat.NORDPASS) "csv" else "json"}"

    /** The name the save dialog suggests for a PassHolder ZIP: passholder-RRRR-MM-DD.zip. */
    fun archiveFileName(day: LocalDate = LocalDate.now()): String = "passholder-$day.zip"

    /** The first bytes of a ZIP archive (a local file header): 50 4B 03 04. */
    private val ZIP_MAGIC = byteArrayOf(0x50, 0x4B, 0x03, 0x04)

    /** Whether the document at [uri] is a ZIP archive, by its first 4 bytes (the name and type are the provider's guess). */
    fun isZip(resolver: ContentResolver, uri: Uri): Boolean = isZip { resolver.openInputStream(uri) }

    /** Reads at most 4 bytes; provider failures become the Polish [READ_FAILED]. */
    internal fun isZip(open: () -> InputStream?): Boolean = readFailing {
        val input = open() ?: throw IOException("no stream")
        input.use {
            val head = ByteArray(ZIP_MAGIC.size)
            var n = 0
            while (n < head.size) {
                val read = it.read(head, n, head.size - n)
                if (read < 0) break
                n += read
            }
            n == head.size && head.contentEquals(ZIP_MAGIC)
        }
    }

    /**
     * The archive to import at [uri], for streaming: opening it and reading from it fail with the Polish
     * [READ_FAILED] (the caller closes it). The archive's own errors are not stream errors and stay as they are.
     */
    fun openArchive(resolver: ContentResolver, uri: Uri): InputStream = openArchive { resolver.openInputStream(uri) }

    internal fun openArchive(open: () -> InputStream?): InputStream {
        val input = readFailing { open() ?: throw IOException("no stream") }
        return object : FilterInputStream(input) {
            override fun read(): Int = readFailing { super.read() }
            override fun read(b: ByteArray, off: Int, len: Int): Int = readFailing { super.read(b, off, len) }
            override fun skip(n: Long): Long = readFailing { super.skip(n) }
            override fun available(): Int = readFailing { super.available() }
        }
    }

    private inline fun <T> readFailing(block: () -> T): T = ProviderStreams.failingAs(READ_FAILED, block = block)

    /**
     * Streams an archive into the document at [uri] ("wt", like [writeText]); [write] gets a buffered stream that is
     * flushed and closed afterwards. Provider and stream failures (IOException, SecurityException) and the vault
     * locking half way ([ErrorCode.VAULT_LOCKED]) become the Polish [WRITE_FAILED]: part of the archive may already be
     * on disk and must be deleted. Cancellation and other exceptions (programming errors) pass through unchanged.
     */
    fun <T> writeArchive(resolver: ContentResolver, uri: Uri, write: (OutputStream) -> T): T =
        writeArchive({ resolver.openOutputStream(uri, "wt") }, write)

    internal fun <T> writeArchive(open: () -> OutputStream?, write: (OutputStream) -> T): T = try {
        val output = open() ?: throw IOException("no stream")
        BufferedOutputStream(output, 64 * 1024).use { write(it) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        throw IOException(WRITE_FAILED, e)
    } catch (e: SecurityException) {
        throw IOException(WRITE_FAILED, e)
    } catch (e: PassHolderException) {
        // The vault locked half way; other errors are not masked.
        if (e.code != ErrorCode.VAULT_LOCKED) throw e
        throw IOException(WRITE_FAILED, e)
    }
}
