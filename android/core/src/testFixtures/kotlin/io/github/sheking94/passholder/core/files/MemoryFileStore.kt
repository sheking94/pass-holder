package io.github.sheking94.passholder.core.files

/** In-memory [FileStore]; capacity counts the summed length of stored blobs. */
class MemoryFileStore(private val capacity: Long = Long.MAX_VALUE) : FileStore {
    private class Stored(val chunks: Int, val createdAt: Long, val blobs: MutableMap<Int, String> = HashMap())

    private val files = LinkedHashMap<String, Stored>()
    private var used = 0L

    override fun chunks(id: String) = files[id]?.chunks

    override fun have(id: String): List<Int> = files[id]?.blobs?.keys?.sorted() ?: emptyList()

    override fun get(id: String, index: Int) = files[id]?.blobs?.get(index)

    override fun put(id: String, index: Int, chunks: Int, blob: String, now: Long) {
        val file = files.getOrPut(id) { Stored(chunks, now) }
        used += blob.length - (file.blobs[index]?.length ?: 0)
        file.blobs[index] = blob
    }

    override fun canStore(bytes: Long) = bytes <= capacity - used

    override fun createdAt(id: String) = files[id]?.createdAt

    override fun ids(): List<String> = files.keys.toList()

    override fun delete(id: String) {
        val file = files.remove(id) ?: return
        used -= file.blobs.values.sumOf { it.length.toLong() }
    }

    override fun clear() {
        files.clear()
        used = 0
    }
}
