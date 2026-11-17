package io.github.sheking94.passholder.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class StrictJsonTest {
    @Test
    fun `string and boolean accept only their own JSON type`() {
        assertEquals("x", StrictJson.string(JsonPrimitive("x")))
        assertEquals("", StrictJson.string(JsonPrimitive("")))
        for (v in listOf(null, JsonNull, JsonPrimitive(1), JsonPrimitive(true), JsonArray(emptyList()), JsonObject(emptyMap()))) {
            assertNull(StrictJson.string(v), "$v")
        }
        assertEquals(true, StrictJson.boolean(JsonPrimitive(true)))
        assertEquals(false, StrictJson.boolean(JsonPrimitive(false)))
        for (v in listOf(null, JsonNull, JsonPrimitive("true"), JsonPrimitive(1), JsonArray(emptyList()))) {
            assertNull(StrictJson.boolean(v), "$v")
        }
    }

    @Test
    fun `appendQuoted escapes like JSON stringify`() {
        val sb = StringBuilder()
        StrictJson.appendQuoted(sb, "a\"b\\c\n\t\u0001\u007f\uD800ż")
        assertEquals("\"a\\\"b\\\\c\\n\\t\\u0001\u007f\\ud800ż\"", sb.toString())
    }

    @Test
    fun `fromUtf8OrNull refuses malformed bytes`() {
        assertEquals("Zażółć", Encoding.fromUtf8OrNull("Zażółć".toByteArray(Charsets.UTF_8)))
        assertNull(Encoding.fromUtf8OrNull(byteArrayOf(0xC3.toByte())))
    }

    @Test
    fun `AtomicFiles write replaces the file and leaves no temporary file`(@TempDir dir: File) {
        val target = File(dir, "state.json")
        AtomicFiles.write(target, byteArrayOf(1, 2))
        AtomicFiles.write(target, byteArrayOf(3))
        assertArrayEquals(byteArrayOf(3), target.readBytes())
        assertFalse(File(dir, "state.json.tmp").exists())
    }
}
