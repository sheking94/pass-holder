package io.github.sheking94.passholder.app

import android.content.ContentResolver
import android.net.Uri
import io.github.sheking94.passholder.core.transfer.TransferFormat
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.time.LocalDate

/**
 * The file side of "Import i eksport": the documents the system file picker returned. Kept out of the screens
 * and the ViewModel so the limits can be tested on bytes.
 */
object TransferFiles {
    /** The largest import file read; one byte more is refused without reading the rest. */
    const val MAX_BYTES = 10 * 1024 * 1024

    const val TOO_LARGE = "Plik jest za duży (limit 10 MiB)"
    const val NOT_UTF8 = "Plik nie jest zapisany w UTF-8"

    /** The text of the import file at [uri]: at most [MAX_BYTES], strict UTF-8. */
    fun readText(resolver: ContentResolver, uri: Uri): String {
        val input = resolver.openInputStream(uri) ?: throw IOException("Nie udało się otworzyć pliku")
        return input.use { decode(readCapped(it)) }
    }

    /** Reads at most [MAX_BYTES] + 1 bytes; the extra byte means the file is too large. */
    fun readCapped(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (out.size() <= MAX_BYTES) {
            val n = input.read(buffer, 0, minOf(buffer.size, MAX_BYTES + 1 - out.size()))
            if (n < 0) break
            out.write(buffer, 0, n)
        }
        if (out.size() > MAX_BYTES) throw IllegalArgumentException(TOO_LARGE)
        return out.toByteArray()
    }

    /** UTF-8 that refuses malformed bytes instead of replacing them (a Windows-1250 file would import garbled names). */
    fun decode(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        throw IllegalArgumentException(NOT_UTF8)
    }

    /** Writes [text] as UTF-8 over the whole document at [uri] ("wt": an existing file is truncated, not overwritten in part). */
    fun writeText(resolver: ContentResolver, uri: Uri, text: String) {
        val output = resolver.openOutputStream(uri, "wt") ?: throw IOException("Nie udało się zapisać pliku")
        output.use { it.write(text.toByteArray(Charsets.UTF_8)) }
    }

    /** The name the save dialog suggests: passholder-RRRR-MM-DD.json, or .csv for NordPass. */
    fun defaultFileName(format: TransferFormat, day: LocalDate = LocalDate.now()): String =
        "passholder-$day.${if (format == TransferFormat.NORDPASS) "csv" else "json"}"
}
