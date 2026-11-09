package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.CustomField
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.DocumentKind
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LabeledValue
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields
import io.github.sheking94.passholder.core.p2p.PostalAddress
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class BitwardenJsonTest {
    private val file = readVector("bitwarden.json")
    private val expected = readExpected("bitwarden.expected.json")

    private fun doc(kind: DocumentKind, number: String) = EntryContentV3(
        "Dokument ${kind.json}", "n",
        DocumentFields(kind, number, "Jan Testowy", "2020-01-01", "2030-01-01", "Urząd"),
        listOf(CustomField("Własne", "x", true)),
    )

    private fun roundTrip(entries: List<EntryContentV3>) = BitwardenJson.parse(BitwardenJson.export(entries))
    private fun items(text: String) = ((Json.parseToJsonElement(text) as JsonObject)["items"] as JsonArray).map { it as JsonObject }
    private fun fieldsOf(o: JsonObject) = (o["fields"] as JsonArray).map { it.toString() }
    private fun f(name: String, value: String, type: Int) = """{"name":"$name","value":"$value","type":$type}"""

    @Test
    fun matchesSharedSampleFile() = assertEquals(expected, BitwardenJson.parse(file))

    @Test
    fun exportMatchesVector() {
        val all = readExpected("passholder.expected.json").entries + expected.entries
        assertEquals(readVector("export.bitwarden.json"), BitwardenJson.export(all))
    }

    @Test
    fun rejectsEncryptedExport() {
        val msg = "Zaszyfrowany eksport Bitwarden nie jest obsługiwany. Wyeksportuj z Bitwardena plik JSON bez szyfrowania."
        assertEquals(msg, assertThrows<IllegalArgumentException> { BitwardenJson.parse("""{"encrypted":true,"data":"x"}""") }.message)
    }

    @Test
    fun rejectsOtherFiles() {
        for (t in listOf("nie json", "[]", """{"items":{}}""")) {
            assertEquals("To nie jest plik Bitwarden JSON", assertThrows<IllegalArgumentException> { BitwardenJson.parse(t) }.message, t)
        }
    }

    @Test
    fun roundTripsEveryDocumentKind() {
        val entries = listOf(
            doc(DocumentKind.ID_CARD, "ABC1"), doc(DocumentKind.PASSPORT, "EA1"), doc(DocumentKind.DRIVING_LICENSE, "DL1"),
            doc(DocumentKind.STUDENT_ID, "S1"), doc(DocumentKind.OTHER, "O1"),
        )
        assertEquals(ParsedImport(sortForExport(entries), emptyList()), roundTrip(entries))
    }

    @Test
    fun roundTripsCardWithPin() {
        val card = EntryContentV3("K", "", CardFields("Jan Testowy", "4111", "03/27", "123", "9876"), listOf(CustomField("Własne", "x", false)))
        assertEquals(ParsedImport(listOf(card), emptyList()), roundTrip(listOf(card)))
    }

    @Test
    fun roundTripsNote() {
        val note = EntryContentV3("N", "tekst", NoteFields, listOf(CustomField("a", "b", false)))
        val text = BitwardenJson.export(listOf(note))
        val item = items(text)[0]
        assertEquals(JsonPrimitive(2), item["type"])
        assertEquals("""{"type":0}""", item["secureNote"].toString())
        assertEquals(JsonPrimitive("tekst"), item["notes"])
        assertEquals(listOf(note), BitwardenJson.parse(text).entries)
    }

    @Test
    fun roundTripsLogin() {
        val login = EntryContentV3(
            "L", "", LoginFields("u", "p", "T", listOf("https://example.com"), listOf("com.example.app")),
            listOf(CustomField("p", "v", false), CustomField("q", "w", true)),
        )
        val text = BitwardenJson.export(listOf(login))
        val item = items(text)[0]
        assertEquals(JsonNull, item["notes"])
        assertEquals(
            """[{"match":null,"uri":"https://example.com"},{"match":null,"uri":"androidapp://com.example.app"}]""",
            ((item["login"] as JsonObject)["uris"]).toString(),
        )
        assertEquals(ParsedImport(listOf(login), emptyList()), BitwardenJson.parse(text))
    }

    @Test
    fun exportsCardExpiryAndPin() {
        val card = EntryContentV3("K", "", CardFields("Jan Testowy", "4111", "03/27", "123", "9876"), emptyList())
        val item = items(BitwardenJson.export(listOf(card)))[0]
        val c = item["card"] as JsonObject
        assertEquals(JsonPrimitive(3), item["type"])
        assertEquals(listOf(JsonPrimitive("3"), JsonPrimitive("2027"), JsonNull, JsonPrimitive("123")), listOf(c["expMonth"], c["expYear"], c["brand"], c["code"]))
        assertEquals(listOf(f("PIN", "9876", 1)), fieldsOf(item))
        val odd = items(BitwardenJson.export(listOf(card.copy(fields = CardFields("Jan Testowy", "4111", "marzec 2027", "123", "")))))[0]
        assertEquals(listOf(JsonNull, JsonNull), listOf((odd["card"] as JsonObject)["expMonth"], (odd["card"] as JsonObject)["expYear"]))
        assertEquals(listOf(f("Ważność", "marzec 2027", 0)), fieldsOf(odd))
    }

    @Test
    fun exportsContactIntoIdentityAndExtraFields() {
        val contact = EntryContentV3(
            "C", "",
            ContactFields(
                "Jan", "Testowy", "1990-01-01",
                listOf(LabeledValue("dom", "1"), LabeledValue("praca", "2"), LabeledValue("", "3")),
                listOf(LabeledValue("", "a@example.com"), LabeledValue("biuro", "b@example.com")),
                listOf(PostalAddress("dom", "ul. A 1", "00-001", "Warszawa", "PL"), PostalAddress("", "ul. B 2", "", "Kraków", "")),
            ),
            emptyList(),
        )
        val item = items(BitwardenJson.export(listOf(contact)))[0]
        val id = item["identity"] as JsonObject
        assertEquals(
            listOf("Jan", "Testowy", "1", "a@example.com", "ul. A 1", "00-001", "Warszawa", "PL").map(::JsonPrimitive),
            listOf("firstName", "lastName", "phone", "email", "address1", "postalCode", "city", "country").map { id[it] },
        )
        assertEquals(
            listOf(
                f("Telefon (praca)", "2", 0), f("Telefon", "3", 0), f("E-mail (biuro)", "b@example.com", 0),
                f("Adres", "ul. B 2, Kraków", 0), f("Data urodzenia", "1990-01-01", 0),
            ),
            fieldsOf(item),
        )
    }

    @Test
    fun writesDocumentKindFieldAndIdentityNumbers() {
        val items = items(BitwardenJson.export(listOf(doc(DocumentKind.PASSPORT, "EA1"), doc(DocumentKind.DRIVING_LICENSE, "DL1"), doc(DocumentKind.ID_CARD, "ID1"))))
        fun byName(n: String) = items.first { (it["name"] as JsonPrimitive).content == n }
        val passport = byName("Dokument passport")["identity"] as JsonObject
        assertEquals(listOf(JsonPrimitive("EA1"), JsonNull, JsonNull), listOf(passport["passportNumber"], passport["licenseNumber"], passport["firstName"]))
        assertEquals(JsonPrimitive("DL1"), (byName("Dokument driving_license")["identity"] as JsonObject)["licenseNumber"])
        val idCard = fieldsOf(byName("Dokument id_card"))
        assertEquals(f("Rodzaj dokumentu", "id_card", 0), idCard[0])
        assertEquals(f("Numer dokumentu", "ID1", 0), idCard[1])
    }

    @Test
    fun startsWithUnencryptedEnvelope() {
        val text = BitwardenJson.export(emptyList())
        assertEquals("""{"encrypted":false,"folders":[],"items":[]}""", Json.parseToJsonElement(text).toString())
        assertTrue(BitwardenJson.isFormat(Json.parseToJsonElement(text)))
    }

    @Test
    fun recognisesItemsArray() {
        assertTrue(BitwardenJson.isFormat(Json.parseToJsonElement(file)))
        for (t in listOf("""{"format":"passholder","entries":[]}""", "[]", "null")) assertFalse(BitwardenJson.isFormat(Json.parseToJsonElement(t)))
    }
}
