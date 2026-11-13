package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.EntryDataV3
import io.github.sheking94.passholder.core.p2p.EntryV3
import io.github.sheking94.passholder.core.p2p.Hlc
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.transfer.PassHolderJson
import io.github.sheking94.passholder.core.transfer.countAttachments
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AttachmentTest {
    private fun att(n: Int) = Attachment(
        "00000000-0000-4000-8000-%012d".format(n), "a$n.txt", "text/plain", 10, 1,
        "a".repeat(64), "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    )

    private fun content(vararg a: Attachment) =
        EntryContentV3("n", "", LoginFields("", ""), emptyList(), a.toList())

    private fun payload(sizeText: String) =
        EntryV3.serialize(EntryDataV3(content(att(1)), Hlc(5, 1, "dev"))).replace("\"size\":10", "\"size\":$sizeText")

    @Test
    fun canAddAndChunkCount() {
        assertTrue(Attachments.canAdd(19))
        assertFalse(Attachments.canAdd(20))
        assertEquals(1, Attachments.chunkCount(262144))
        assertEquals(2, Attachments.chunkCount(262145))
    }

    @Test
    fun emptyListSerializesWithoutKey() {
        val s = EntryV3.serialize(EntryDataV3(content(), Hlc(5, 1, "dev")))
        assertFalse(s.contains("attachments"))
        assertEquals(
            "{\"v\":3,\"type\":\"login\",\"name\":\"n\",\"note\":\"\",\"fields\":{\"username\":\"\",\"password\":\"\",\"totp\":\"\"," +
                "\"urls\":[],\"androidApps\":[]},\"custom\":[],\"hlc\":{\"ms\":5,\"c\":1,\"d\":\"dev\"}}",
            s,
        )
    }

    @Test
    fun serializesAttachmentsBetweenCustomAndHlc() {
        val s = EntryV3.serialize(EntryDataV3(content(att(1)), Hlc(5, 1, "dev")))
        assertTrue(s.contains("\"custom\":[],\"attachments\":[{\"id\":\"00000000-0000-4000-8000-000000000001\",\"name\":\"a1.txt\""))
        assertTrue(s.contains("\"key\":\"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=\"}],\"hlc\""))
    }

    @Test
    fun parsesIntegralJsonNumbers() {
        assertEquals(10L, EntryV3.parse(Json.parseToJsonElement(payload("1.0e1"))).content.attachments[0].size)
        assertEquals(10L, EntryV3.parse(Json.parseToJsonElement(payload("10.0"))).content.attachments[0].size)
        assertEquals(1L, EntryV3.parse(Json.parseToJsonElement(payload("1e0"))).content.attachments[0].size)
        assertThrows(IllegalArgumentException::class.java) { EntryV3.parse(Json.parseToJsonElement(payload("1e400"))) }
        assertThrows(IllegalArgumentException::class.java) { EntryV3.parse(Json.parseToJsonElement(payload("1.5"))) }
        assertThrows(IllegalArgumentException::class.java) { EntryV3.parse(Json.parseToJsonElement(payload("\"10\""))) }
    }

    @Test
    fun jsonIntRules() {
        assertEquals(1L, jsonInt(JsonPrimitive(1), 0, 5))
        assertEquals(1L, jsonInt(Json.parseToJsonElement("1.0"), 0, 5))
        assertNull(jsonInt(Json.parseToJsonElement("1.5"), 0, 5))
        assertNull(jsonInt(JsonPrimitive("1"), 0, 5))
        assertNull(jsonInt(Json.parseToJsonElement("null"), 0, 5))
        assertNull(jsonInt(null, 0, 5))
        assertNull(jsonInt(JsonPrimitive(6), 0, 5))
        assertNull(jsonInt(Json.parseToJsonElement("1e400"), 0, 5))
    }

    @Test
    fun exportOmitsAttachments() {
        val text = PassHolderJson.export(listOf(content(att(1))))
        assertFalse(text.contains("attachments"))
    }

    @Test
    fun countsAttachments() {
        assertEquals(2, countAttachments(listOf(content(att(1), att(2)), content())))
    }
}
