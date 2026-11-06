package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.RemoteRecord
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.atomic.AtomicInteger

class PhoneVaultTest {
    private val key = ByteArray(32) { (it + 1).toByte() }
    private val epoch = "epoch-1"
    private val store = MemorySyncStore()
    private var wall = 1_700_000_000_000L
    private fun vault(s: SyncStore = store, device: String = "phone") = PhoneVault(s, key, device) { wall }
    private fun cred(name: String) = Credentials(name, "user-$name", "pw-$name")

    private fun readEntry(id: String): EntryDataV2 =
        EntryV2.parseEntry(EntryV2.decrypt(key, id, store.get(id)!!.blob))

    @Test
    fun rejectsOutOfRangeDeviceAndEntryIds() {
        assertThrows<IllegalArgumentException> { vault(device = "") }
        assertThrows<IllegalArgumentException> { vault(device = "d".repeat(65)) }
        vault(device = "d".repeat(64))
        val v = vault()
        assertThrows<IllegalArgumentException> { v.upsert("", cred("A")) }
        assertThrows<IllegalArgumentException> { v.upsert("i".repeat(129), cred("A")) }
        assertThrows<IllegalArgumentException> { v.delete("") }
        assertThrows<IllegalArgumentException> { v.delete("i".repeat(129)) }
        assertEquals(0L, store.currentRevision())
        v.upsert("i".repeat(128), cred("A"))
        assertEquals(1L, store.currentRevision())
    }

    @Test
    fun upsertWritesRevisionOneWithDeviceHlc() {
        vault().upsert("a", cred("A"))
        val rec = store.get("a")!!
        assertEquals(1L, rec.revision)
        assertEquals(false, rec.deleted)
        val data = readEntry("a")
        assertEquals("A", data.name)
        assertEquals("phone", data.hlc.d)
    }

    @Test
    fun editOfFutureEntryGetsLargerHlc() {
        val future = Hlc(wall + 365L * 24 * 3600 * 1000, 3, "ext")
        store.put(RemoteRecord("a", 1, false, EntryV2.encrypt(key, "a", EntryDataV2("A", "u", "p", future))))
        vault().upsert("a", cred("A2"))
        assertTrue(readEntry("a").hlc > future)
        assertEquals(2L, store.get("a")!!.revision)
    }

    @Test
    fun deleteWritesTombstoneAndHidesEntry() {
        val v = vault()
        v.upsert("a", cred("A"))
        v.delete("a")
        val rec = store.get("a")!!
        assertEquals(2L, rec.revision)
        assertEquals(true, rec.deleted)
        val t = EntryV2.parseTombstone(EntryV2.decrypt(key, "a", rec.blob))
        assertEquals("phone", t.hlc.d)
        assertTrue(v.entries().isEmpty())
        assertTrue(v.unreadableIds().isEmpty())
    }

    @Test
    fun deleteUnknownIdIsNoop() {
        val v = vault()
        v.upsert("a", cred("A"))
        v.delete("zzz")
        assertEquals(1L, store.currentRevision())
        assertEquals(null, store.get("zzz"))
    }

    @Test
    fun newVaultContinuesClockAfterLargestHlc() {
        val future = Hlc(wall + 10_000_000, 7, "ext")
        store.put(RemoteRecord("x", 1, false, EntryV2.encrypt(key, "x", EntryDataV2("X", "u", "p", future))))
        store.put(RemoteRecord("t", 2, true, EntryV2.encryptTombstone(key, "t", TombstoneDataV2(Hlc(wall + 20_000_000, 1, "ext")))))
        vault().upsert("new", cred("N"))
        val h = readEntry("new").hlc
        assertTrue(h > Hlc(wall + 20_000_000, 1, "ext"), "hlc $h")
        assertEquals("phone", h.d)
    }

    @Test
    fun entriesSortedByNameWithoutTombstones() {
        val v = vault()
        v.upsert("1", cred("Zeta"))
        v.upsert("2", cred("Alpha"))
        v.upsert("3", cred("Mid"))
        v.delete("3")
        val list = v.entries()
        assertEquals(listOf("Alpha", "Zeta"), list.map { it.credentials.name })
        assertEquals(listOf("2", "1"), list.map { it.id })
        assertEquals(2L, list[0].revision)
        assertEquals("phone", list[0].hlc.d)
    }

    @Test
    fun upsertVisibleToHostSync() {
        vault().upsert("a", cred("A"))
        val resp = HostSync.process(store, epoch, emptyList(), requestJson(0))
        assertEquals(listOf("a"), resp.changes.map { it.id })
        assertEquals(1L, resp.currentRevision)
    }

    @Test
    fun changeFromPluginAppearsInEntries() {
        val hlc = Hlc(wall, 0, "ext")
        val blob = EntryV2.encrypt(key, "p", EntryDataV2("Plug", "u", "pw", hlc))
        val resp = HostSync.process(store, epoch, emptyList(), requestJson(0, change("p", 0, blob)))
        assertEquals(1, resp.accepted.size)
        val e = vault().entries()
        assertEquals(1, e.size)
        assertEquals("Plug", e[0].credentials.name)
        assertEquals(hlc, e[0].hlc)
    }

    @Test
    fun concurrentUpsertsAndHostProcessKeepRevisionsUnique() {
        val v = vault()
        val accepted = AtomicInteger()
        val errors = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
        fun run(body: () -> Unit) = Thread {
            try { body() } catch (e: Throwable) { errors.add(e) }
        }
        val threads = listOf(
            run { repeat(200) { v.upsert("a$it", cred("A$it")) } },
            run { repeat(200) { v.upsert("b$it", cred("B$it")) } },
            run {
                repeat(50) {
                    val r = HostSync.process(store, epoch, emptyList(), requestJson(0, change("h$it", 0, "blob$it")))
                    accepted.addAndGet(r.accepted.size)
                }
            },
        )
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        assertTrue(errors.isEmpty(), errors.toString())
        assertEquals(50, accepted.get())
        val total = 200L + 200L + accepted.get()
        assertEquals(total, store.currentRevision())
        val revs = store.listSince(0).map { it.revision }
        assertEquals(total.toInt(), revs.size)
        assertEquals(total.toInt(), revs.toSet().size)
    }

    @Test
    fun garbageRecordIsReportedAndOthersStayVisible() {
        val v = vault()
        v.upsert("a", cred("A"))
        store.put(RemoteRecord("bad", 2, false, "not-a-blob"))
        // Valid ciphertext, but a tombstone payload where an entry is expected.
        store.put(RemoteRecord("bad2", 3, false, EntryV2.encryptTombstone(key, "bad2", TombstoneDataV2(Hlc(1, 0, "x")))))
        // Tombstone sealed for another id.
        store.put(RemoteRecord("bad3", 4, true, EntryV2.encryptTombstone(key, "other", TombstoneDataV2(Hlc(1, 0, "x")))))
        assertEquals(listOf("A"), v.entries().map { it.credentials.name })
        assertEquals(setOf("bad", "bad2", "bad3"), v.unreadableIds().toSet())
        assertNotNull(store.get("bad"))
    }

    private data class Ch(val id: String, val base: Long, val blob: String)

    private fun change(id: String, base: Long, blob: String) = Ch(id, base, blob)

    private fun requestJson(since: Long, vararg changes: Ch): kotlinx.serialization.json.JsonElement {
        val cs = changes.joinToString(",") {
            """{"id":"${it.id}","baseRevision":${it.base},"deleted":false,"blob":"${it.blob}"}"""
        }
        return P2pJson.json.parseToJsonElement("""{"epoch":"$epoch","sinceRevision":$since,"changes":[$cs]}""")
    }
}
