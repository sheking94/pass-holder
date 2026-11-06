package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ChangeRequest
import io.github.sheking94.passholder.core.RemoteRecord
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class FileSyncStoreTest {
    @TempDir
    lateinit var dir: File

    private fun file() = File(dir, "sync.jsonl")

    @Test
    fun reopenSeesRecordsAndRevision() {
        val a = FileSyncStore(file())
        a.put(RemoteRecord("a", 1, false, "x"))
        a.put(RemoteRecord("b", 2, true, "y"))
        a.put(RemoteRecord("c", 3, false, "z"))
        val b = FileSyncStore(file())
        assertEquals(3, b.currentRevision())
        assertEquals(RemoteRecord("b", 2, true, "y"), b.get("b"))
        assertEquals(listOf("a", "b", "c"), b.listSince(0).map { it.id })
    }

    @Test
    fun overwriteWinsAfterReopen() {
        val a = FileSyncStore(file())
        a.put(RemoteRecord("a", 1, false, "old"))
        a.put(RemoteRecord("a", 2, false, "new"))
        assertEquals(RemoteRecord("a", 2, false, "new"), FileSyncStore(file()).get("a"))
    }

    @Test
    fun truncatedLastLineIsIgnoredAndNextPutSurvives() {
        file().writeText("""{"id":"a","revision":1,"deleted":false,"blob":"x"}""" + "\n" + """{"id":"a","rev""")
        val a = FileSyncStore(file())
        assertEquals(1, a.currentRevision())
        a.put(RemoteRecord("b", a.currentRevision() + 1, false, "y"))
        val b = FileSyncStore(file())
        assertEquals(2, b.currentRevision())
        assertEquals(RemoteRecord("b", 2, false, "y"), b.get("b"))
        assertEquals(RemoteRecord("a", 1, false, "x"), b.get("a"))
    }

    @Test
    fun garbageInTheMiddleIsCorrupt() {
        file().writeText(
            """{"id":"a","revision":1,"deleted":false,"blob":"x"}""" + "\n" + "garbage\n" +
                """{"id":"b","revision":2,"deleted":false,"blob":"x"}""" + "\n",
        )
        val e = assertThrows(IllegalStateException::class.java) { FileSyncStore(file()) }
        assertEquals("Corrupt sync store", e.message)
    }

    @Test
    fun manyOverwritesAreCompactedOnOpen() {
        val a = FileSyncStore(file())
        for (i in 1..300) a.put(RemoteRecord("a", i.toLong(), false, "v$i"))
        assertEquals(300, file().readLines().size)
        val b = FileSyncStore(file())
        assertEquals(1, file().readLines().size)
        assertEquals(RemoteRecord("a", 300, false, "v300"), b.get("a"))
        assertEquals(300, FileSyncStore(file()).currentRevision())
    }

    @Test
    fun hostSyncGivesSameAnswersForBothStores() {
        val epoch = "epoch-1"
        fun change(id: String, base: Long = 0, deleted: Boolean = false) =
            P2pJson.json.encodeToJsonElement(ChangeRequest.serializer(), ChangeRequest(id, base, deleted, "blob-$id"))
        fun request(since: Long, vararg changes: JsonElement, epoch: String = "epoch-1"): JsonElement = buildJsonObject {
            put("epoch", epoch)
            put("sinceRevision", since)
            put("changes", buildJsonArray { changes.forEach { add(it) } })
        }
        val requests = listOf(
            request(0, change("a"), change("b")),
            request(0),
            request(2, change("a", 1), change("c")),
            request(2, change("b", 1)),
            request(0, change("ghost", 7)),
            request(0, change("c", 3, deleted = true)),
            request(99, change("z")),
            request(0, change("y"), epoch = "other"),
            request(0, change("a"), change("a")),
        )
        val memory = MemorySyncStore()
        val file = FileSyncStore(file())
        for (r in requests) {
            val m = runCatching { HostSync.process(memory, epoch, listOf("a:1"), r) }
            val f = runCatching { HostSync.process(file, epoch, listOf("a:1"), r) }
            assertEquals(m.getOrNull(), f.getOrNull(), r.toString())
            assertEquals(m.exceptionOrNull()?.message, f.exceptionOrNull()?.message, r.toString())
        }
        assertEquals(memory.currentRevision(), file.currentRevision())
        assertTrue(memory.currentRevision() > 0)
        val reopened = FileSyncStore(file())
        assertEquals(memory.listSince(0), reopened.listSince(0))
    }
}
