package io.github.sheking94.passholder.core.files

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class FileHostTest {
    private val id = "123e4567-e89b-42d3-a456-426614174000"

    private fun put() = JsonObject(
        mapOf(
            "op" to JsonPrimitive("put"), "epoch" to JsonPrimitive("e"), "id" to JsonPrimitive(id),
            "index" to JsonPrimitive(0), "chunks" to JsonPrimitive(1), "blob" to JsonPrimitive("AAAA"),
        ),
    )

    /** A store that counts writes and widens the race window between the existence check and the write. */
    private class CountingStore : FileStore {
        private val inner = MemoryFileStore()
        var puts = 0
        override fun chunks(id: String) = inner.chunks(id)
        override fun have(id: String) = inner.have(id)
        override fun get(id: String, index: Int): String? { Thread.yield(); return inner.get(id, index) }
        override fun put(id: String, index: Int, chunks: Int, blob: String, now: Long) {
            puts++; inner.put(id, index, chunks, blob, now)
        }
        override fun canStore(bytes: Long) = inner.canStore(bytes)
        override fun createdAt(id: String) = inner.createdAt(id)
        override fun ids() = inner.ids()
        override fun delete(id: String) = inner.delete(id)
        override fun clear() = inner.clear()
    }

    @Test
    fun concurrentPutsOfTheSameChunkStoreItOnce() {
        val store = CountingStore()
        val pool = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)
        val futures = List(8) {
            pool.submit<FileReply> { start.await(); FileHost.process(store, "e", put(), 1L) }
        }
        start.countDown()
        val replies = futures.map { it.get(30, TimeUnit.SECONDS) }
        pool.shutdown()
        val ok = JsonObject(mapOf("have" to JsonPrimitive(1)))
        replies.forEach { assertEquals(200, it.status); assertEquals(ok, it.body) }
        assertEquals(1, store.puts)
        assertEquals(listOf(0), store.have(id))
    }
}
