package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import javax.crypto.AEADBadTagException

class EntryCodecTest {
    private val key = ByteArray(32) { it.toByte() }
    private val hlc = Hlc(5, 1, "dev")
    private val custom = listOf(CustomField("l", "v", true))

    private fun content(fields: EntryFields, note: String = "x") = EntryContent("n", note, fields, custom)

    private val samples = listOf(
        EntryData(content(LoginFields("u", "p", "t", listOf("https://a"), listOf("pkg"))), hlc),
        EntryData(
            content(
                ContactFields(
                    "A",
                    "B",
                    "1990-01-02",
                    listOf(LabeledValue("home", "1")),
                    listOf(LabeledValue("w", "a@b")),
                    listOf(PostalAddress("h", "s", "p", "c", "PL")),
                ),
            ),
            hlc,
        ),
        EntryData(content(CardFields("h", "1", "01/30", "123", "0000")), hlc),
        EntryData(content(NoteFields), hlc),
        EntryData(content(DocumentFields(DocumentKind.PASSPORT, "n", "f", "a", "b", "i")), hlc),
    )

    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)
    private fun parseOf(data: EntryData) = EntryCodec.parse(json(EntryCodec.serialize(data)))

    private fun assertInvalid(message: String, block: () -> Unit) {
        val e = assertThrows(IllegalArgumentException::class.java) { block() }
        assertEquals(message, e.message)
    }

    private fun assertRejected(text: String) = assertInvalid("Invalid entry payload") { EntryCodec.parse(json(text)) }

    private val loginJson = EntryCodec.serialize(samples[0])

    @Test
    fun parsesEveryType() {
        for (x in samples) assertEquals(x, parseOf(x))
    }

    @Test
    fun readsV2PayloadAsLogin() {
        val p = EntryCodec.parse(json("""{"name":"a","username":"u","password":"p","hlc":{"ms":5,"c":1,"d":"dev"}}"""))
        assertEquals(EntryData(EntryContent("a", "", LoginFields("u", "p", "", emptyList(), emptyList()), emptyList()), hlc), p)
    }

    @Test
    fun rejectsInvalidEntries() {
        val h = """{"ms":5,"c":1,"d":"dev"}"""
        val cases = listOf(
            loginJson.replace("\"type\":\"login\"", "\"type\":\"wifi\""),
            loginJson.replace("\"v\":3", "\"v\":2"),
            loginJson.replace("\"v\":3", "\"v\":\"3\""),
            loginJson.replace("\"v\":3", "\"v\":3.5"),
            loginJson.replace("\"v\":3", "\"v\":3.0"),
            loginJson.replace("\"v\":3", "\"v\":3e0"),
            loginJson.replace("\"totp\":\"t\",", ""),
            loginJson.replace("[\"https://a\"]", "[1]"),
            loginJson.replace("\"hidden\":true", "\"hidden\":\"true\""),
            loginJson.replace("\"hidden\":true", "\"hidden\":null"),
            loginJson.replace("{\"v\":3,", "{\"v\":3,\"extra\":1,"),
            loginJson.replace("\"totp\":", "\"extra\":1,\"totp\":"),
            loginJson.replace("\"hidden\":true", "\"hidden\":true,\"extra\":1"),
            EntryCodec.serialize(samples[1]).replace("\"country\":\"PL\"", "\"country\":\"PL\",\"extra\":1"),
            EntryCodec.serialize(samples[3]).replace("\"fields\":{}", "\"fields\":{\"x\":\"\"}"),
            EntryCodec.serialize(samples[4]).replace("\"passport\"", "\"visa\""),
            """{"name":"a","username":"u","password":"p","hlc":$h,"deleted":true}""",
            loginJson.replace("\"d\":\"dev\"}", "\"d\":\"dev\",\"extra\":1}"),
            loginJson.replace("\"d\":\"dev\"", "\"z\":1"),
            """{"name":"a","username":"u","password":"p","hlc":{"ms":5,"c":1,"d":"dev","extra":1}}""",
            """{"name":"a","username":"u","hlc":$h}""",
            "[]",
        )
        for (c in cases) assertRejected(c)
    }

    @Test
    fun rejectsTextMs() {
        assertInvalid("Invalid HLC") {
            EntryCodec.parse(json("""{"name":"n","username":"u","password":"p","hlc":{"ms":"1","c":0,"d":"x"}}"""))
        }
    }

    @Test
    fun doesNotCheckDateFormats() {
        val c = EntryCodec.serialize(samples[1]).replace("1990-01-02", "1.2.1990")
        assertTrue(EntryCodec.parse(json(c)).content.fields is ContactFields)
    }

    @Test
    fun strictTombstone() {
        val h = """{"ms":5,"c":1,"d":"dev"}"""
        assertEquals(TombstoneData(hlc), EntryCodec.parseTombstone(json("""{"hlc":$h}""")))
        for (c in listOf(
            """{"hlc":$h,"name":"x"}""",
            """{"hlc":$h,"deleted":true}""",
            """{"hlc":{"ms":5,"c":1,"d":"dev","extra":1}}""",
            "[]",
            """{"hlc":{"ms":5,"c":1}}""",
        )) {
            assertInvalid("Invalid tombstone payload") { EntryCodec.parseTombstone(json(c)) }
        }
    }

    @Test
    fun serializesInFixedKeyOrder() {
        val d = EntryData(EntryContent("nm", "x", LoginFields("n", "p", "t", listOf("u"), listOf("a")), emptyList()), hlc)
        assertEquals(
            """{"v":3,"type":"login","name":"nm","note":"x","fields":{"username":"n","password":"p","totp":"t","urls":["u"],"androidApps":["a"]},"custom":[],"hlc":{"ms":5,"c":1,"d":"dev"}}""",
            EntryCodec.serialize(d),
        )
        assertEquals("""{"hlc":{"ms":5,"c":1,"d":"dev"}}""", EntryCodec.serializeTombstone(TombstoneData(hlc)))
    }

    @Test
    fun escapesLikeJsStringify() {
        val s = "\"\\\b\u000C\n\r\t\u0001\u001f\u007f  <>&'=🙂\uD800"
        val d = EntryData(EntryContent("", s, NoteFields, emptyList()), hlc)
        assertTrue(EntryCodec.serialize(d).contains("\"note\":\"\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u007f  <>&'=🙂\\ud800\""))
    }

    @Test
    fun roundTrip() {
        for (x in samples) assertEquals(x, EntryCodec.parse(EntryCodec.decrypt(key, "id1", EntryCodec.encrypt(key, "id1", x))))
    }

    @Test
    fun tombstoneRoundTrip() {
        val opened = EntryCodec.decrypt(key, "id1", EntryCodec.encryptTombstone(key, "id1", TombstoneData(hlc)))
        assertEquals(TombstoneData(hlc), EntryCodec.parseTombstone(opened))
    }

    @Test
    fun blobOfOtherIdDoesNotOpen() {
        val blob = EntryCodec.encrypt(key, "id1", samples[0])
        assertThrows(AEADBadTagException::class.java) { EntryCodec.decrypt(key, "id2", blob) }
    }

    @Test
    fun v1BlobDoesNotOpen() {
        val blob = Aead.seal(key, Encoding.utf8("""{"name":"n","username":"u","password":"p"}"""), "passholder/v1/entry/id1")
        assertThrows(AEADBadTagException::class.java) { EntryCodec.decrypt(key, "id1", blob) }
    }

    @Test
    fun blobLengthMatchesEncryption() {
        val d = EntryData(EntryContent("n", "ż🙂".repeat(1000), NoteFields, emptyList()), hlc)
        assertEquals(EntryCodec.encrypt(key, "id", d).length, EntryCodec.blobLength(EntryCodec.serialize(d)))
    }

    @Test
    fun boundaryCountsUtf8Bytes() {
        fun withNote(note: String) = EntryData(EntryContent("n", note, NoteFields, emptyList()), hlc)
        fun bytes(note: String) = Encoding.utf8(EntryCodec.serialize(withNote(note))).size
        val zs = "ż".repeat(1000)
        val note = zs + "a".repeat(49123 - bytes(zs))
        assertEquals(49123, bytes(note))
        assertEquals(EntryCodec.MAX_BLOB_LENGTH, EntryCodec.blobLength(EntryCodec.serialize(withNote(note))))
        EntryCodec.encrypt(key, "id", withNote(note))
        assertThrows(EntryTooLargeException::class.java) { EntryCodec.encrypt(key, "id", withNote(note + "ż")) }
        assertEquals("Entry too large", EntryTooLargeException().message)
    }

    @Test
    fun contentJsonRoundTripsAndHasFixedKeyOrder() {
        for (d in samples) {
            val j = EntryCodec.contentJson(d.content)
            assertEquals(listOf("type", "name", "note", "fields", "custom"), j.keys.toList())
            assertEquals(d.content, EntryCodec.parseContent(j))
        }
    }

    @Test
    fun parseContentRejectsExtraOrMissingKeys() {
        val j = EntryCodec.contentJson(samples[0].content)
        assertInvalid("Invalid entry payload") { EntryCodec.parseContent(kotlinx.serialization.json.JsonObject(j + ("hlc" to json("{}")))) }
        assertInvalid("Invalid entry payload") { EntryCodec.parseContent(kotlinx.serialization.json.JsonObject(j - "note")) }
    }
}
