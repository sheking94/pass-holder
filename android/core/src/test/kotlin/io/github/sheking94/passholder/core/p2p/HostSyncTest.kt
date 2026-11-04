package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Accepted
import io.github.sheking94.passholder.core.ChangeRequest
import io.github.sheking94.passholder.core.RemoteRecord
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HostSyncTest {
    private val epoch = "epoch-1"

    private fun change(id: String, base: Long = 0) = ChangeRequest(id, base, false, "blob")

    private fun changeJson(id: String, base: Long = 0): JsonElement =
        P2pJson.json.encodeToJsonElement(ChangeRequest.serializer(), change(id, base))

    private fun request(sinceRevision: Long, vararg changes: JsonElement, epoch: String = this.epoch): JsonObject =
        buildJsonObject {
            put("epoch", epoch)
            put("sinceRevision", sinceRevision)
            put("changes", buildJsonArray { changes.forEach { add(it) } })
        }

    private fun requestRaw(since: JsonElement?, changes: JsonElement? = buildJsonArray {}): JsonObject =
        buildJsonObject {
            put("epoch", epoch)
            if (since != null) put("sinceRevision", since)
            if (changes != null) put("changes", changes)
        }

    private fun num(text: String): JsonElement = P2pJson.json.parseToJsonElement(text)

    private fun withField(c: JsonElement, key: String, value: JsonElement): JsonElement =
        JsonObject((c as JsonObject) + (key to value))

    private fun records(n: Int) = MemorySyncStore().also { s ->
        for (i in 1..n) s.put(RemoteRecord("id$i", i.toLong(), false, "x"))
    }

    // --- processSync ---

    @Test
    fun acceptedChangeGetsNextRevision() {
        val store = MemorySyncStore()
        store.put(RemoteRecord("a", 4, false, "x"))
        val res = HostSync.processSync(store, 0, listOf(change("n")))
        assertEquals(listOf(Accepted("n", 5)), res.accepted)
        assertEquals(5, res.currentRevision)
        assertEquals(RemoteRecord("n", 5, false, "blob"), store.get("n"))
    }

    @Test
    fun staleBaseRevisionYieldsConflictWithStoreVersion() {
        val store = MemorySyncStore()
        val existing = RemoteRecord("a", 3, false, "server")
        store.put(existing)
        val res = HostSync.processSync(store, 0, listOf(change("a", 2)))
        assertEquals(listOf(existing), res.conflicts)
        assertTrue(res.accepted.isEmpty())
        assertEquals(existing, store.get("a"))
    }

    @Test
    fun changesSkipAcceptedAndConflictIds() {
        val store = MemorySyncStore()
        store.put(RemoteRecord("a", 1, false, "x"))
        store.put(RemoteRecord("b", 2, false, "x"))
        store.put(RemoteRecord("c", 3, false, "x"))
        val res = HostSync.processSync(store, 0, listOf(change("a", 1), change("b", 1)))
        assertEquals(listOf("a"), res.accepted.map { it.id })
        assertEquals(listOf("b"), res.conflicts.map { it.id })
        assertEquals(listOf("c"), res.changes.map { it.id })
    }

    @Test
    fun listSinceIsSortedByRevision() {
        val store = MemorySyncStore()
        store.put(RemoteRecord("z", 3, false, "x"))
        store.put(RemoteRecord("y", 1, false, "x"))
        store.put(RemoteRecord("x", 2, false, "x"))
        assertEquals(listOf(1L, 2L, 3L), store.listSince(0).map { it.revision })
        assertEquals(listOf(3L), store.listSince(2).map { it.revision })
    }

    // --- paging ---

    @Test
    fun hostReturnsAtMostMaxChangesPerResponseAndContinues() {
        val store = records(1300)
        fun page(since: Long) = HostSync.process(store, epoch, emptyList(), request(since))
        val first = page(0)
        assertEquals(HostSync.MAX_CHANGES_PER_RESPONSE, first.changes.size)
        assertTrue(first.more)
        assertEquals(500, first.currentRevision)
        assertEquals((1L..500L).toList(), first.changes.map { it.revision })
        val second = page(500)
        assertTrue(second.more)
        assertEquals(1000, second.currentRevision)
        val last = page(1000)
        assertTrue(!last.more)
        assertEquals(1300, last.currentRevision)
        assertEquals(300, last.changes.size)
        assertTrue(!HostSync.process(store, epoch, emptyList(), request(0, epoch = "")).more)
    }

    @Test
    fun hostRejectsMoreThanMaxChangesPerRequest() {
        val store = MemorySyncStore()
        val changes = (0..HostSync.MAX_CHANGES_PER_REQUEST).map { changeJson("$it") }.toTypedArray()
        val e = assertThrows(IllegalArgumentException::class.java) {
            HostSync.process(store, epoch, emptyList(), request(0, *changes))
        }
        assertEquals("too many changes", e.message)
        assertEquals(0, store.currentRevision())
    }

    @Test
    fun hostIgnoresChangesWithStaleEpoch() {
        val store = MemorySyncStore()
        val res = HostSync.process(store, epoch, listOf("a:1"), request(0, changeJson("1"), epoch = "other"))
        assertEquals(0, store.currentRevision())
        assertNull(store.get("1"))
        assertEquals(P2pSyncResponse(epoch, 0, emptyList(), emptyList(), emptyList(), listOf("a:1"), false), res)
    }

    @Test
    fun sinceRevisionAheadOfStoreIsIgnoredWithoutWrites() {
        val store = MemorySyncStore()
        store.put(RemoteRecord("known", 1, false, "blob"))
        val res = HostSync.process(store, epoch, listOf("a:1"), request(5, changeJson("ghost", 3), changeJson("fresh")))
        assertEquals(P2pSyncResponse(epoch, 1, emptyList(), emptyList(), emptyList(), listOf("a:1"), false), res)
        assertEquals(1, store.currentRevision())
        assertNull(store.get("fresh"))
        assertThrows(IllegalArgumentException::class.java) {
            HostSync.process(store, epoch, emptyList(), request(5, changeJson("a"), changeJson("a")))
        }
    }

    @Test
    fun processAppliesChangesAndEncodesResponse() {
        val store = MemorySyncStore()
        val res = HostSync.process(store, epoch, listOf("a:1"), request(0, changeJson("n")))
        assertEquals(listOf(Accepted("n", 1)), res.accepted)
        assertEquals(1, res.currentRevision)
        assertEquals(
            """{"epoch":"epoch-1","currentRevision":1,"accepted":[{"id":"n","revision":1}],"conflicts":[],"changes":[],"addresses":["a:1"],"more":false}""",
            P2pJson.json.encodeToString(res),
        )
    }

    // --- validation ---

    @Test
    fun invalidRequestIsRefusedWithoutWriting() {
        val store = MemorySyncStore()
        assertThrows(IllegalArgumentException::class.java) {
            HostSync.process(store, epoch, emptyList(), request(0, changeJson("a"), changeJson("a")))
        }
        val e = assertThrows(IllegalArgumentException::class.java) {
            HostSync.process(store, epoch, emptyList(), request(0, changeJson("a"), changeJson("b", 2)))
        }
        assertEquals("unknown base revision", e.message)
        assertEquals(0, store.currentRevision())
    }

    @Test
    fun malformedOrDuplicateChangesAreRejected() {
        val store = MemorySyncStore()
        val ok = changeJson("ok")
        val x = changeJson("x")
        val bad: List<Pair<JsonElement, String>> = listOf(
            withField(x, "id", JsonPrimitive(1)) to "malformed change",
            changeJson("") to "malformed change",
            changeJson("x".repeat(129)) to "malformed change",
            withField(x, "baseRevision", num("-1")) to "malformed change",
            withField(x, "baseRevision", num("1.5")) to "malformed change",
            withField(x, "baseRevision", JsonPrimitive("5")) to "malformed change",
            withField(x, "baseRevision", num("1e20")) to "malformed change",
            withField(x, "baseRevision", num("9007199254740992")) to "malformed change",
            withField(x, "baseRevision", JsonNull) to "malformed change",
            withField(x, "deleted", JsonPrimitive("no")) to "malformed change",
            withField(x, "blob", JsonPrimitive(1)) to "malformed change",
            JsonNull to "malformed change",
            ok to "duplicate change",
        )
        for ((c, message) in bad) {
            assertEquals(message, HostSync.validate(store, epoch, request(0, ok, c)), c.toString())
            val e = assertThrows(IllegalArgumentException::class.java, { HostSync.process(store, epoch, emptyList(), request(0, ok, c)) }, c.toString())
            assertEquals(message, e.message)
            assertEquals(0, store.currentRevision())
            assertNull(store.get("ok"))
        }
        assertNull(HostSync.validate(store, epoch, request(0, changeJson("x".repeat(128)))))
    }

    @Test
    fun malformedSinceRevisionIsRejected() {
        val store = MemorySyncStore()
        val values = listOf(
            JsonPrimitive("5"), num("1.5"), num("-1"), num("1e20"), num("9007199254740992"), JsonNull, null,
        )
        for (v in values) {
            assertEquals("malformed sync request", HostSync.validate(store, epoch, requestRaw(v)), "$v")
            assertThrows(IllegalArgumentException::class.java) { HostSync.process(store, epoch, emptyList(), requestRaw(v)) }
            assertEquals(0, store.currentRevision())
        }
        assertNull(HostSync.validate(store, epoch, requestRaw(num("0"))))
    }

    @Test
    fun malformedRequestShapesAreRejected() {
        val store = MemorySyncStore()
        val shapes = listOf(
            JsonPrimitive("x"), buildJsonArray {}, JsonNull,
            buildJsonObject { put("sinceRevision", 0); put("changes", buildJsonArray {}) },
            buildJsonObject { put("epoch", 1); put("sinceRevision", 0); put("changes", buildJsonArray {}) },
            requestRaw(num("0"), null),
            requestRaw(num("0"), JsonPrimitive("c")),
        )
        for (s in shapes) assertEquals("malformed sync request", HostSync.validate(store, epoch, s), s.toString())
    }

    @Test
    fun unknownBaseRevisionOnlyMattersInOwnEpoch() {
        val store = MemorySyncStore()
        assertEquals(
            "unknown base revision",
            HostSync.validate(store, epoch, request(0, changeJson("a"), changeJson("ghost", 5))),
        )
        assertNull(HostSync.validate(store, epoch, request(0, changeJson("ghost", 5), epoch = "")))
        assertEquals(0, store.currentRevision())
    }
}
