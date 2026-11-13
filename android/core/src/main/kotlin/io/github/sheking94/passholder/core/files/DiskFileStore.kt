package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.p2p.P2pJson
import kotlinx.serialization.Serializable
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * [FileStore] on disk: `dir/<id>/meta.json` (`{"chunks":n,"createdAt":ms}`) and `dir/<id>/<i>` (blob).
 * Every file is written as `.tmp`, fsynced and atomically renamed, so an existing chunk file is always whole;
 * a file is complete when its chunk count equals `chunks`. Leftover `.tmp` files, directories with a name
 * that is not a UUID and directories without a readable `meta.json` are removed on open.
 */
class DiskFileStore(
    private val dir: File,
    private val freeSpace: () -> Long = { dir.usableSpace },
    private val minFree: Long = MIN_FREE_BYTES,
) : FileStore {
    @Serializable
    private class Meta(val chunks: Int, val createdAt: Long)

    init {
        dir.mkdirs()
        for (child in dir.listFiles().orEmpty()) {
            if (!child.isDirectory || !Attachments.UUID_V4.matches(child.name)) {
                child.deleteRecursively()
                continue
            }
            child.listFiles { f -> f.name.endsWith(".tmp") }?.forEach { it.delete() }
            if (readMeta(child.name) == null) child.deleteRecursively()
        }
    }

    private fun readMeta(id: String): Meta? {
        val f = File(File(dir, id), "meta.json")
        return try {
            if (!f.isFile) null else P2pJson.json.decodeFromString(Meta.serializer(), f.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            null
        }
    }

    private fun writeAtomic(target: File, bytes: ByteArray) {
        val tmp = File(target.path + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    private fun valid(id: String) = Attachments.UUID_V4.matches(id)

    override fun chunks(id: String): Int? = if (valid(id)) readMeta(id)?.chunks else null

    override fun have(id: String): List<Int> {
        if (!valid(id)) return emptyList()
        val names = File(dir, id).list() ?: return emptyList()
        return names.mapNotNull { n -> n.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toIntOrNull() }.sorted()
    }

    override fun get(id: String, index: Int): String? {
        if (!valid(id)) return null
        val f = File(File(dir, id), index.toString())
        return if (f.isFile) f.readText(Charsets.UTF_8) else null
    }

    override fun put(id: String, index: Int, chunks: Int, blob: String, now: Long) {
        require(valid(id)) { "Invalid file id" }
        val d = File(dir, id)
        d.mkdirs()
        if (readMeta(id) == null) {
            writeAtomic(File(d, "meta.json"), P2pJson.json.encodeToString(Meta.serializer(), Meta(chunks, now)).toByteArray(Charsets.UTF_8))
        }
        writeAtomic(File(d, index.toString()), blob.toByteArray(Charsets.UTF_8))
    }

    override fun canStore(bytes: Long) = freeSpace() - bytes >= minFree

    override fun createdAt(id: String): Long? = if (valid(id)) readMeta(id)?.createdAt else null

    override fun ids(): List<String> =
        dir.listFiles().orEmpty().filter { it.isDirectory && valid(it.name) && readMeta(it.name) != null }.map { it.name }.sorted()

    override fun delete(id: String) {
        if (valid(id)) File(dir, id).deleteRecursively()
    }

    override fun clear() {
        dir.listFiles().orEmpty().forEach { it.deleteRecursively() }
    }

    companion object {
        const val MIN_FREE_BYTES = 52_428_800L
    }
}
