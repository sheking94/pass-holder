package io.github.sheking94.passholder.app

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.contract.ActivityResultContract
import io.github.sheking94.passholder.core.files.Attachments
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** A file chosen in the system picker, read into memory. */
data class PickedFile(val name: String, val mime: String, val bytes: ByteArray)

/**
 * The system side of attachments: reading a picked file and saving a downloaded one, plus the texts of the
 * attachment screens. Kept out of the screens and the ViewModel so the limits can be tested without them.
 */
object AttachmentFiles {
    const val TOO_MANY = "Najwyżej 20 plików we wpisie"
    const val EMPTY = "Plik jest pusty"
    const val TOO_LARGE = "Plik jest za duży (limit 10 MB)"
    const val BAD_NAME = "Nieprawidłowa nazwa pliku"

    const val WAITING = "czeka na synchronizację"
    const val NEW = "nowy – zapisz wpis"
    const val CORRUPTED = "Plik jest uszkodzony"

    const val READ_FAILED = "Nie udało się odczytać pliku."
    const val VAULT_READ_FAILED = "Nie udało się odczytać pliku z sejfu."
    const val WRITE_FAILED = "Nie udało się zapisać pliku. Jeśli plik powstał, usuń go."

    const val DOWNLOAD_WARNING = "Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym urządzeniu."

    private const val DEFAULT_NAME = "plik"

    /** The file at [uri]: name and size from the provider (when it says), type from [ContentResolver.getType]. */
    fun read(resolver: ContentResolver, uri: Uri): PickedFile {
        var name: String? = null
        var size: Long? = null
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                    val s = c.getColumnIndex(OpenableColumns.SIZE)
                    if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
                }
            }
        } catch (_: RuntimeException) {
            // A provider that cannot answer the query is read as one that does not know name and size.
        }
        val mime = try {
            resolver.getType(uri)
        } catch (_: RuntimeException) {
            null
        }
        return read(name, mime, size) { resolver.openInputStream(uri) }
    }

    /**
     * Checks the known [size] without opening the stream, then reads at most [Attachments.MAX_FILE_SIZE] + 1 bytes,
     * then empty, too large, name. Provider failures (IOException, SecurityException, null stream) become the
     * Polish [READ_FAILED]; the limit messages are IllegalArgumentException.
     */
    internal fun read(name: String?, mime: String?, size: Long?, open: () -> InputStream?): PickedFile {
        if (size != null) {
            if (size > Attachments.MAX_FILE_SIZE) throw IllegalArgumentException(TOO_LARGE)
            if (size == 0L) throw IllegalArgumentException(EMPTY)
        }
        val bytes = try {
            val input = open() ?: throw IOException("no stream")
            input.use { readCapped(it, size) }
        } catch (_: IOException) {
            throw IOException(READ_FAILED)
        } catch (_: RuntimeException) {
            // SecurityException and whatever else a provider throws; our own limit messages are thrown below.
            throw IOException(READ_FAILED)
        }
        try {
            if (bytes.isEmpty()) throw IllegalArgumentException(EMPTY)
            if (bytes.size > Attachments.MAX_FILE_SIZE) throw IllegalArgumentException(TOO_LARGE)
            val fileName = name ?: DEFAULT_NAME
            if (!Attachments.isName(fileName)) throw IllegalArgumentException(BAD_NAME)
            return PickedFile(fileName, mime ?: "", bytes)
        } catch (e: IllegalArgumentException) {
            bytes.fill(0)
            throw e
        }
    }

    /**
     * Reads at most [Attachments.MAX_FILE_SIZE] + 1 bytes into one array of our own (no stream buffers that would
     * keep plaintext): the extra byte tells the caller the file is too large. The result has exactly the bytes read;
     * every larger array is zeroed, also when reading fails.
     */
    private fun readCapped(input: InputStream, knownSize: Long?): ByteArray {
        val limit = Attachments.MAX_FILE_SIZE + 1
        var buf = ByteArray(if (knownSize != null) minOf(maxOf(knownSize + 1, 1L), limit.toLong()).toInt() else 64 * 1024)
        var n = 0
        try {
            while (n < limit) {
                if (n == buf.size) {
                    val bigger = buf.copyOf(minOf(buf.size.toLong() * 2, limit.toLong()).toInt())
                    buf.fill(0)
                    buf = bigger
                }
                val r = input.read(buf, n, buf.size - n)
                if (r < 0) break
                n += r
            }
            return if (n == buf.size) buf else buf.copyOf(n).also { buf.fill(0) }
        } catch (e: Throwable) {
            buf.fill(0)
            throw e
        }
    }

    /** Writes [bytes] over the whole document at [uri] ("wt": an existing file is truncated, not overwritten in part). */
    fun write(resolver: ContentResolver, uri: Uri, bytes: ByteArray) = write(bytes) { resolver.openOutputStream(uri, "wt") }

    /** Provider failures (IOException, SecurityException, null stream) become the Polish [WRITE_FAILED]. */
    internal fun write(bytes: ByteArray, open: () -> OutputStream?) {
        try {
            val output = open() ?: throw IOException("no stream")
            output.use { it.write(bytes) }
        } catch (_: IOException) {
            throw IOException(WRITE_FAILED)
        } catch (_: RuntimeException) {
            // SecurityException and whatever else a provider throws: never its raw (English) message.
            throw IOException(WRITE_FAILED)
        }
    }
}

/** The system "save as" dialog for a downloaded attachment: suggests [Input.name], type [Input.mime] (any, when empty). */
class CreateDocumentOf : ActivityResultContract<CreateDocumentOf.Input, Uri?>() {
    data class Input(val name: String, val mime: String)

    override fun createIntent(context: Context, input: Input): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType(input.mime.ifEmpty { "application/octet-stream" })
        .putExtra(Intent.EXTRA_TITLE, input.name)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
}
