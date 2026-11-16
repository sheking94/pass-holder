package io.github.sheking94.passholder.core.files

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

class DiskFileStoreTest {
    @TempDir
    lateinit var dir: File

    private val id = "11111111-1111-4111-8111-111111111111"
    private val id2 = "22222222-2222-4222-8222-222222222222"
    private fun open(free: Long = Long.MAX_VALUE) = DiskFileStore(dir, { free })

    private fun put(store: FileStore, id: String, i: Int, n: Int, blob: String = "blob$i", now: Long = 1000) = FileHost.process(
        store,
        "E",
        JsonObject(
            mapOf(
                "epoch" to JsonPrimitive("E"),
                "op" to JsonPrimitive("put"),
                "id" to JsonPrimitive(id),
                "chunks" to JsonPrimitive(n),
                "index" to JsonPrimitive(i),
                "blob" to JsonPrimitive(blob),
            ),
        ),
        now,
    )

    @Test
    fun hostStepsMatchVectors() {
        val h = FilesVectors.root.getValue("host").jsonObject
        FileHostSteps.run(open(), h.str("epoch"), h.int("now"), h.getValue("steps").jsonArray)
    }

    @Test
    fun survivesReopen() {
        val a = open()
        a.put(id, 0, 3, "x0", 42)
        a.put(id, 2, 3, "x2", 42)
        val b = open()
        assertEquals(3, b.chunks(id))
        assertEquals(listOf(0, 2), b.have(id))
        assertEquals("x2", b.get(id, 2))
        assertNull(b.get(id, 1))
        assertEquals(42L, b.createdAt(id))
        assertEquals(listOf(id), b.ids())
    }

    @Test
    fun leftoverTmpFilesAreRemovedOnOpen() {
        val a = open()
        a.put(id, 0, 4, "x0", 1)
        File(dir, "$id/3.tmp").writeText("partial")
        File(dir, "$id/meta.json.tmp").writeText("{")
        val b = open()
        assertEquals(listOf(0), b.have(id))
        assertEquals(emptyList<String>(), File(dir, id).list()!!.filter { it.endsWith(".tmp") })
    }

    @Test
    fun directoryWithoutMetaIsRemoved() {
        File(dir, id).mkdirs()
        File(dir, "$id/0").writeText("x")
        File(dir, "junk").mkdirs()
        File(dir, id2).mkdirs()
        File(dir, "$id2/meta.json").writeText("not json")
        val s = open()
        assertEquals(emptyList<String>(), s.ids())
        assertFalse(File(dir, id).exists())
        assertFalse(File(dir, "junk").exists())
        assertFalse(File(dir, id2).exists())
    }

    @Test
    fun corruptMetaIsTreatedAsNoMeta() {
        File(dir, id).mkdirs()
        File(dir, "$id/meta.json").writeText("{\"chunks\":")
        File(dir, id2).mkdirs()
        File(dir, "$id2/meta.json").writeText("{\"chunks\":\"x\",\"createdAt\":1}")
        val s = open()
        assertEquals(emptyList<String>(), s.ids())
        assertFalse(File(dir, id).exists())
        assertFalse(File(dir, id2).exists())
    }

    @Test
    fun insufficientStorageIs507() {
        val s = open(DiskFileStore.MIN_FREE_BYTES + 9)
        assertEquals(507, put(s, id, 0, 1, "0123456789").status)
        assertEquals(200, put(s, id, 0, 1, "012345678").status)
        assertTrue(s.canStore(9))
        assertFalse(s.canStore(10))
    }

    @Test
    fun deleteAndClearRemoveDirectories() {
        val s = open()
        s.put(id, 0, 1, "a", 1)
        s.put(id2, 0, 1, "b", 1)
        s.delete(id)
        assertFalse(File(dir, id).exists())
        assertEquals(listOf(id2), s.ids())
        s.clear()
        assertEquals(emptyList<String>(), s.ids())
        assertFalse(File(dir, id2).exists())
    }

    @Test
    fun concurrentPutsOfTheSameChunk() {
        val s = open()
        val start = CountDownLatch(1)
        val replies = java.util.Collections.synchronizedList(ArrayList<FileReply>())
        val threads = List(8) {
            thread {
                start.await()
                replies += put(s, id, 0, 1, "same")
            }
        }
        start.countDown()
        threads.forEach { it.join() }
        assertEquals(8, replies.size)
        replies.forEach {
            assertEquals(200, it.status)
            assertEquals(JsonObject(mapOf("have" to JsonPrimitive(1))), it.body)
        }
        assertEquals(setOf("0", "meta.json"), File(dir, id).list()!!.toSet())
    }
}
