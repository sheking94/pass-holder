package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.NoteFields
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class PassHolderJsonTest {
    private val file = readVector("passholder.json")
    private val expected = readExpected("passholder.expected.json")
    private val msg = "To nie jest plik PassHolder w wersji 3"

    @Test
    fun matchesSharedSampleFile() = assertEquals(expected, PassHolderJson.parse(file))

    @Test
    fun coversEveryEntryType() =
        assertEquals(listOf("login", "contact", "card", "note", "document"), expected.entries.map { it.fields.type })

    @Test
    fun rejectsOtherVersionsFormatsAndShapes() {
        for (t in listOf(
            """{"format":"passholder","version":2,"entries":[]}""", """{"format":"other","version":3,"entries":[]}""",
            """{"format":"passholder","version":3,"entries":{}}""", """{"format":"passholder","version":"3","entries":[]}""",
            "[]", "null", "nie json",
        )) {
            assertEquals(msg, assertThrows<IllegalArgumentException> { PassHolderJson.parse(t) }.message, t)
        }
    }

    @Test
    fun skipsEntryWithUnknownKeyByPosition() {
        val r = PassHolderJson.parse(file)
        assertEquals(ImportSkip("wpis 6", "zły format wpisu"), r.skipped[0])
        assertEquals(5, r.entries.size)
    }

    @Test
    fun skipsBlankNames() {
        val e = """"type":"note","note":"","fields":{},"custom":[]"""
        val text = """{"format":"passholder","version":3,"entries":[{$e,"name":"  "},{$e,"name":""},{$e,"name":"Ok"}]}"""
        assertEquals(
            ParsedImport(
                listOf(EntryContentV3("Ok", "", NoteFields, emptyList())),
                listOf(ImportSkip("wpis 1", "brak nazwy"), ImportSkip("wpis 2", "brak nazwy")),
            ),
            PassHolderJson.parse(text),
        )
    }

    @Test
    fun exportMatchesVector() {
        val all = expected.entries + readExpected("bitwarden.expected.json").entries
        assertEquals(readVector("export.passholder.json"), PassHolderJson.export(all))
    }

    @Test
    fun roundTripsSorted() {
        val text = PassHolderJson.export(expected.entries)
        assertEquals(ParsedImport(sortForExport(expected.entries), emptyList()), PassHolderJson.parse(text))
        assertTrue(text.endsWith("}\n"))
    }

    @Test
    fun recognisesFormatMarker() {
        assertTrue(PassHolderJson.isFormat(Json.parseToJsonElement(file)))
        for (t in listOf("[]", "null", """{"format":"bitwarden"}""")) assertFalse(PassHolderJson.isFormat(Json.parseToJsonElement(t)))
    }
}
