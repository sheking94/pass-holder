package io.github.sheking94.passholder.core.save

import io.github.sheking94.passholder.core.autofill.matchUrl
import java.io.File
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

private fun readCases(name: String): List<JsonObject> {
    val text = File(System.getProperty("passholder.repoRoot"), "core/test-vectors/save/$name").readText()
    return ((Json.parseToJsonElement(text) as JsonObject)["cases"] as JsonArray).map { it as JsonObject }
}

class SaveVectorsTest {
    @Test
    fun urlVectors() {
        val cases = readCases("url.json")
        assertEquals(true, cases.isNotEmpty())
        for (c in cases) {
            val page = c["page"]!!.jsonPrimitive.content
            val expected = c["expected"]!!.takeIf { it !is JsonNull }?.jsonPrimitive?.content
            assertEquals(expected, saveUrl(page), "saveUrl($page)")
            if (expected != null) {
                assertEquals(c["name"]!!.jsonPrimitive.content, saveName(expected), "saveName($expected)")
                assertNotNull(matchUrl(page, expected), "matchUrl($page, $expected)")
            }
        }
    }

    @Test
    fun decideVectors() {
        val cases = readCases("decide.json")
        assertEquals(true, cases.isNotEmpty())
        for (c in cases) {
            val logins = (c["logins"] as JsonArray).map {
                val o = it as JsonObject
                SavedLogin(o["id"]!!.jsonPrimitive.content, o["username"]!!.jsonPrimitive.content, o["password"]!!.jsonPrimitive.content)
            }
            val e = c["expected"] as JsonObject
            val expected = when (val kind = e["kind"]!!.jsonPrimitive.content) {
                "none" -> SaveDecision.None
                "create" -> SaveDecision.Create
                "update" -> SaveDecision.Update(e["id"]!!.jsonPrimitive.content)
                else -> error("unknown kind $kind")
            }
            val actual = decideSave(c["username"]!!.jsonPrimitive.content, c["password"]!!.jsonPrimitive.content, logins)
            assertEquals(expected, actual, c["why"]?.jsonPrimitive?.content)
        }
    }
}
