package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.NoteFields
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class SortVectorTest {
    @Test
    fun matchesNodeLocaleCompareVector() {
        val file = File(System.getProperty("passholder.repoRoot"), "core/test-vectors/transfer/sort.json")
        val o = Json.parseToJsonElement(file.readText()) as JsonObject
        fun list(k: String) = (o[k] as JsonArray).map { it.jsonPrimitive.content }
        val entries = list("names").map { EntryContentV3(it, "", NoteFields, emptyList()) }
        assertEquals(list("sorted"), sortForExport(entries).map { it.name })
    }
}
