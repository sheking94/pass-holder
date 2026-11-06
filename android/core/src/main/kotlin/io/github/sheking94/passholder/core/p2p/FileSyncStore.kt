package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.RemoteRecord
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * File-backed [SyncStore]: JSON Lines, one RemoteRecord per line, every put appended and fsynced.
 * Not thread-safe, callers must hold synchronized(store) (same contract as [MemorySyncStore]).
 *
 * On open the map is rebuilt (a later line with the same id wins). An unparsable last line (torn write) is
 * dropped and the file rewritten; an unparsable line anywhere else throws IllegalStateException("Corrupt sync store").
 * The file is also rewritten when it holds more than 2 * records + 100 lines.
 */
class FileSyncStore(private val file: File) : SyncStore {
    private val records = HashMap<String, RemoteRecord>()
    private var revision = 0L

    init {
        load()
    }

    private fun parse(line: String): RemoteRecord? = try {
        P2pJson.json.decodeFromString(RemoteRecord.serializer(), line)
    } catch (_: Exception) {
        null
    }

    private fun load() {
        if (!file.exists()) return
        val text = file.readText(Charsets.UTF_8)
        val lines = text.split('\n').filter { it.isNotBlank() }
        var needsRewrite = text.isNotEmpty() && !text.endsWith("\n")
        var validLines = 0
        for ((index, line) in lines.withIndex()) {
            val record = parse(line)
            if (record == null) {
                if (index != lines.lastIndex) throw IllegalStateException("Corrupt sync store")
                needsRewrite = true
                continue
            }
            validLines++
            records[record.id] = record
            revision = maxOf(revision, record.revision)
        }
        if (needsRewrite || validLines > 2 * records.size + 100) rewrite()
    }

    private fun rewrite() {
        val tmp = File(file.path + ".tmp")
        FileOutputStream(tmp).use { out ->
            val content = records.values.sortedBy { it.revision }
                .joinToString("") { P2pJson.json.encodeToString(RemoteRecord.serializer(), it) + "\n" }
            out.write(content.toByteArray(Charsets.UTF_8))
            out.flush()
            out.fd.sync()
        }
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    override fun get(id: String): RemoteRecord? = records[id]

    override fun put(record: RemoteRecord) {
        val line = P2pJson.json.encodeToString(RemoteRecord.serializer(), record) + "\n"
        FileOutputStream(file, true).use { out ->
            out.write(line.toByteArray(Charsets.UTF_8))
            out.flush()
            out.fd.sync()
        }
        records[record.id] = record
        revision = maxOf(revision, record.revision)
    }

    override fun listSince(revision: Long): List<RemoteRecord> =
        records.values.filter { it.revision > revision }.sortedBy { it.revision }

    override fun currentRevision(): Long = revision
}
