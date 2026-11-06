package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import javax.crypto.AEADBadTagException

class EntryV2Test {
    private val key = ByteArray(32) { it.toByte() }
    private val hlc = Hlc(1_000, 0, "dev")
    private val entry = EntryDataV2("n", "u", "p", hlc)

    @Test
    fun roundTrip() {
        val opened = EntryV2.decrypt(key, "id1", EntryV2.encrypt(key, "id1", entry))
        assertEquals(entry, EntryV2.parseEntry(opened))
    }

    @Test
    fun tombstoneRoundTrip() {
        val opened = EntryV2.decrypt(key, "id1", EntryV2.encryptTombstone(key, "id1", TombstoneDataV2(hlc)))
        assertEquals(TombstoneDataV2(hlc), EntryV2.parseTombstone(opened))
    }

    @Test
    fun blobOfOtherIdDoesNotOpen() {
        val blob = EntryV2.encrypt(key, "id1", entry)
        assertThrows(AEADBadTagException::class.java) { EntryV2.decrypt(key, "id2", blob) }
    }

    @Test
    fun v1BlobDoesNotOpen() {
        val blob = Aead.seal(key, Encoding.utf8("""{"name":"n","username":"u","password":"p"}"""), "passholder/v1/entry/id1")
        assertThrows(AEADBadTagException::class.java) { EntryV2.decrypt(key, "id1", blob) }
    }

    @Test
    fun parseEntryRejectsMissingPassword() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            EntryV2.parseEntry(Json.parseToJsonElement("""{"name":"n","username":"u","hlc":{"ms":1,"c":0,"d":"x"}}"""))
        }
        assertEquals("Invalid entry payload", e.message)
    }

    @Test
    fun parseEntryRejectsTextMs() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            EntryV2.parseEntry(Json.parseToJsonElement("""{"name":"n","username":"u","password":"p","hlc":{"ms":"1","c":0,"d":"x"}}"""))
        }
        assertEquals("Invalid HLC", e.message)
    }

    @Test
    fun parseTombstoneRejectsNonObject() {
        val e = assertThrows(IllegalArgumentException::class.java) { EntryV2.parseTombstone(Json.parseToJsonElement("[]")) }
        assertEquals("Invalid tombstone payload", e.message)
    }
}
