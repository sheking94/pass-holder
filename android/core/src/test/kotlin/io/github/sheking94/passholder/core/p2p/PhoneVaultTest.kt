package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.Encoding
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

    private fun readEntry(id: String): EntryDataV3 =
        EntryV3.parse(EntryV3.decrypt(key, id, store.get(id)!!.blob))

    private fun login(name: String, hlc: Hlc, username: String = "u", password: String = "p") =
        EntryDataV3(EntryContentV3(name, "", LoginFields(username, password), emptyList()), hlc)

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
        assertEquals("A", data.content.name)
        assertEquals("phone", data.hlc.d)
    }

    @Test
    fun editOfFutureEntryGetsLargerHlc() {
        val future = Hlc(wall + 365L * 24 * 3600 * 1000, 3, "ext")
        store.put(RemoteRecord("a", 1, false, EntryV3.encrypt(key, "a", login("A", future))))
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
        val t = EntryV3.parseTombstone(EntryV3.decrypt(key, "a", rec.blob))
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
        store.put(RemoteRecord("x", 1, false, EntryV3.encrypt(key, "x", login("X", future))))
        store.put(RemoteRecord("t", 2, true, EntryV3.encryptTombstone(key, "t", TombstoneData(Hlc(wall + 20_000_000, 1, "ext")))))
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
        val blob = EntryV3.encrypt(key, "p", login("Plug", hlc))
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
        store.put(RemoteRecord("bad2", 3, false, EntryV3.encryptTombstone(key, "bad2", TombstoneData(Hlc(1, 0, "x")))))
        // Tombstone sealed for another id.
        store.put(RemoteRecord("bad3", 4, true, EntryV3.encryptTombstone(key, "other", TombstoneData(Hlc(1, 0, "x")))))
        assertEquals(listOf("A"), v.entries().map { it.credentials.name })
        assertEquals(setOf("bad", "bad2", "bad3"), v.unreadableIds().toSet())
        assertNotNull(store.get("bad"))
    }

    private val h0 = Hlc(1, 0, "ext")
    private val rich = EntryContentV3(
        "Rich", "my note", LoginFields("u", "p", "totp-secret", listOf("https://a.pl"), listOf("pl.app")),
        listOf(CustomField("pin", "1234", true)),
    )

    @Test
    fun editKeepsV3Fields() {
        val v = vault()
        v.upsertContent("a", rich)
        v.upsert("a", Credentials("Renamed", "u2", "p2"))
        val c = readEntry("a").content
        assertEquals(
            rich.copy(name = "Renamed", fields = (rich.fields as LoginFields).copy(username = "u2", password = "p2")),
            c,
        )
    }

    @Test
    fun newLoginHasEmptyExtras() {
        vault().upsert("a", cred("A"))
        assertEquals(EntryContentV3("A", "", LoginFields("user-A", "pw-A"), emptyList()), readEntry("a").content)
    }

    private fun note(name: String) = EntryContentV3(name, "tekst", NoteFields, emptyList())
    private fun cardContent(name: String) = EntryContentV3(name, "", CardFields("H", "4111 1111 1111 1111", "01/30", "123", "0000"), emptyList())

    @Test
    fun `entries returns every type sorted by name`() {
        val v = vault()
        v.upsert("l", cred("B"))
        v.upsertContent("c", cardContent("A"))
        v.upsertContent("n", note("C"))
        val list = v.entries()
        assertEquals(listOf("A", "B", "C"), list.map { it.content.name })
        assertEquals(listOf("card", "login", "note"), list.map { it.content.fields.type })
        assertTrue(v.unreadableIds().isEmpty())
    }

    @Test
    fun `upsertContent refuses an id holding another type`() {
        val v = vault()
        v.upsertContent("e1", cardContent("Karta"))
        val before = store.get("e1")
        assertThrows<EntryTypeMismatchException> {
            v.upsertContent("e1", EntryContentV3("L", "", LoginFields("u", "p"), emptyList()))
        }
        assertEquals(before, store.get("e1"))
        assertEquals(1L, store.currentRevision())
        assertEquals("card", v.entries().single().content.fields.type)
    }

    @Test
    fun `upsertContent over a tombstone may change the type`() {
        val v = vault()
        v.upsertContent("e1", cardContent("Karta"))
        v.delete("e1")
        v.upsertContent("e1", note("Notatka"))
        assertEquals("note", v.entries().single().content.fields.type)
    }

    @Test
    fun `upsert of a login keeps totp, urls, androidApps, note and custom`() {
        val v = vault()
        v.upsertContent("a", rich)
        v.upsert("a", Credentials("Renamed", "u2", "p2"))
        val c = readEntry("a").content
        val f = c.fields as LoginFields
        assertEquals("totp-secret", f.totp)
        assertEquals(listOf("https://a.pl"), f.urls)
        assertEquals(listOf("pl.app"), f.androidApps)
        assertEquals("my note", c.note)
        assertEquals(listOf(CustomField("pin", "1234", true)), c.custom)
    }

    @Test
    fun readsV2Blob() {
        val v2 = """{"name":"Old","username":"ou","password":"op","hlc":{"ms":5,"c":0,"d":"ext"}}"""
        store.put(RemoteRecord("o", 1, false, EntryV3.encryptJson(key, "o", v2, ByteArray(12))))
        val e = vault().entries().single()
        assertEquals(Credentials("Old", "ou", "op"), e.credentials)
        assertEquals(LoginFields("ou", "op"), e.data.content.fields)
    }

    @Test
    fun tooLargeLeavesStore() {
        val v = vault()
        v.upsert("a", cred("A"))
        val before = store.get("a")
        assertThrows<EntryTooLargeException> { v.upsert("a", Credentials("A", "u", "x".repeat(70_000))) }
        assertThrows<EntryTooLargeException> { v.upsert("b", Credentials("B", "u", "x".repeat(70_000))) }
        assertEquals(1L, store.currentRevision())
        assertEquals(before, store.get("a"))
        assertEquals(null, store.get("b"))
    }

    @Test
    fun tombstoneIsExact() {
        val v = vault()
        v.upsert("a", cred("A"))
        v.delete("a")
        val json = Encoding.fromUtf8(Aead.open(key, store.get("a")!!.blob, EntryV3.aad("a")))
        assertTrue(Regex("""\{"hlc":\{"ms":\d+,"c":\d+,"d":"phone"\}\}""").matches(json), json)
    }

    @Test
    fun upsertOnLiveNonLoginThrowsAndChangesNothing() {
        val v = vault()
        v.upsertContent("n", EntryContentV3("Notatka", "tekst", NoteFields, emptyList()))
        val before = store.get("n")
        assertThrows<EntryTypeMismatchException> { v.upsert("n", cred("X")) }
        assertEquals(before, store.get("n"))
        assertEquals(1L, store.currentRevision())
    }

    @Test
    fun upsertOnDeletedNonLoginIdWritesLogin() {
        val v = vault()
        v.upsertContent("n", EntryContentV3("Notatka", "tekst", NoteFields, emptyList()))
        v.delete("n")
        v.upsert("n", cred("X"))
        assertEquals(listOf("X"), v.entries().map { it.credentials.name })
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
