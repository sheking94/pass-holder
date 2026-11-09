package io.github.sheking94.passholder.core.transfer

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class JsonTextTest {
    private fun s(text: String) = JsonText.stringify(Json.parseToJsonElement(text))

    @Test
    fun matchesJsStringifyWithIndent2() {
        val expected = listOf(
            "{",
            "  \"a\": [",
            "    1,",
            "    {",
            "      \"b\": null",
            "    },",
            "    []",
            "  ],",
            "  \"c\": {},",
            "  \"d\": true,",
            "  \"e\": 1.5",
            "}",
        ).joinToString("\n")
        assertEquals(expected, s("""{"a":[1,{"b":null},[]],"c":{},"d":true,"e":1.5}"""))
    }

    @Test
    fun scalarsAndEmpties() {
        assertEquals("[]", s("[]"))
        assertEquals("{}", s("{}"))
        assertEquals("null", s("null"))
        assertEquals("42", s("42"))
        assertEquals("true", s("true"))
    }

    @Test
    fun escapesLikeJs() {
        val input = JsonPrimitive("zażółć \"x\"\n\u0001\u001f\b\u000C\r\t\\/")
        val expected = "\"zażółć \\\"x\\\"\\n\\u0001\\u001f\\b\\f\\r\\t\\\\/\""
        assertEquals(expected, JsonText.stringify(input))
    }
}
