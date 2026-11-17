package io.github.sheking94.passholder.app

import java.io.IOException
import java.io.InputStream

/** Shared reading from documents of the system file picker (TransferFiles, AttachmentFiles). */
internal object ProviderStreams {
    /**
     * Runs a call to a document provider. Its failures (IOException, SecurityException; with [anyRuntime] every
     * RuntimeException, because providers throw whatever they like) become IOException([message]) with the original
     * as the cause, so the user sees our Polish text and never the provider's raw (English) one.
     */
    inline fun <T> failingAs(message: String, anyRuntime: Boolean = false, block: () -> T): T = try {
        block()
    } catch (e: IOException) {
        throw IOException(message, e)
    } catch (e: RuntimeException) {
        if (!anyRuntime && e !is SecurityException) throw e
        throw IOException(message, e)
    }

    /**
     * Reads at most [limit] + 1 bytes into one array of our own (no stream buffers that would keep plaintext): the
     * extra byte tells the caller the file is too large. [knownSize] (from the provider) sizes the first array. The
     * result has exactly the bytes read; every larger array is zeroed, also when reading fails.
     */
    fun readCapped(input: InputStream, limit: Int, knownSize: Long? = null): ByteArray {
        val max = limit + 1
        var buf = ByteArray(if (knownSize != null) minOf(maxOf(knownSize + 1, 1L), max.toLong()).toInt() else 64 * 1024)
        var n = 0
        try {
            while (n < max) {
                if (n == buf.size) {
                    val bigger = buf.copyOf(minOf(buf.size.toLong() * 2, max.toLong()).toInt())
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
}
