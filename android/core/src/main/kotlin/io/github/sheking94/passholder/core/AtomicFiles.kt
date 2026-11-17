package io.github.sheking94.passholder.core

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/** Writing a file so that a crash leaves either the old content or the new one, never a mix. */
object AtomicFiles {
    /** Writes target.tmp, fsyncs it, renames it over [target], then fsyncs the directory (best effort). */
    fun write(target: File, bytes: ByteArray) {
        val tmp = File(target.path + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        // Persist the rename itself (the directory entry); some platforms do not allow opening a directory.
        try {
            FileChannel.open(target.absoluteFile.parentFile.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (_: IOException) {
        }
    }
}
