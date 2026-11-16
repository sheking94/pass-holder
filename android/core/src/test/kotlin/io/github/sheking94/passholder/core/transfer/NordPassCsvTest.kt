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
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class NordPassCsvTest {
    private val header =
        "name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder," +
            "full_name,phone_number,email,address1,address2,city,country,state,totp,shared_folder"

    private val login = EntryContentV3(
        "Poczta",
        "notatka",
        LoginFields("jan", "p,\"a\"\nss", "JBSWY3DPEHPK3PXP", listOf("https://example.com"), emptyList()),
        emptyList(),
    )
    private val card = EntryContentV3("Karta", "", CardFields("Jan Testowy", "4111111111111111", "12/30", "123", ""), emptyList())
    private val contact = EntryContentV3(
        "Jan",
        "",
        ContactFields(
            "Jan",
            "Maria Testowy",
            "",
            listOf(LabeledValue("", "500100200")),
            listOf(LabeledValue("", "jan@example.com")),
            listOf(PostalAddress("", "ul. Przykładowa 1", "00-001", "Warszawa", "Polska")),
        ),
        emptyList(),
    )
    private val note = EntryContentV3("Notatka", "tekst", NoteFields, emptyList())

    private fun exportedRow(e: EntryContentV3): Map<String, String> {
        val rows = Csv.parse(NordPassCsv.export(listOf(e)))
        return NordPassCsv.COLUMNS.mapIndexed { i, c -> c to rows[1].fields[i] }.toMap()
    }

    private fun fail(text: String) = assertThrows<IllegalArgumentException> { NordPassCsv.parse(text) }.message

    @Test
    fun sampleFilesMatchExpected() {
        for (name in listOf("nordpass", "nordpass-typed")) {
            assertEquals(readExpected("$name.expected.json"), NordPassCsv.parse(readVector("$name.csv")), name)
        }
    }

    @Test
    fun coversEveryTypeAndSkips() {
        val plain = NordPassCsv.parse(readVector("nordpass.csv"))
        assertEquals(listOf("login", "login", "card", "contact", "note", "login", "login"), plain.entries.map { it.fields.type })
        assertEquals(listOf(ImportSkip("wiersz 7", "brak nazwy i adresu")), plain.skipped)
        val typed = NordPassCsv.parse(readVector("nordpass-typed.csv"))
        assertEquals(listOf("login", "note", "card", "contact", "login"), typed.entries.map { it.fields.type })
        assertEquals(listOf(ImportSkip("wiersz 6", "typ „folder” nie jest obsługiwany")), typed.skipped)
    }

    @Test
    fun rejectsEmptyAndForeignFile() {
        assertEquals("Plik jest pusty", fail(""))
        assertEquals("To nie wygląda na eksport z NordPass: brak kolumn name/url w pierwszym wierszu", fail("foo,bar\n1,2"))
    }

    @Test
    fun acceptsHeaderOnly() = assertEquals(ParsedImport(emptyList(), emptyList()), NordPassCsv.parse("$header\n"))

    @Test
    fun shortRowTreatsMissingColumnsAsEmpty() {
        val r = NordPassCsv.parse("$header\nKrótki,https://example.com\n")
        assertTrue(r.skipped.isEmpty())
        assertEquals(
            EntryContentV3("Krótki", "", LoginFields("", "", "", listOf("https://example.com"), emptyList()), emptyList()),
            r.entries[0],
        )
    }

    @Test
    fun findsColumnsByNameInAnyOrder() {
        val r = NordPassCsv.parse(" Password ,NAME,Username\ns1,Poczta,jan\n")
        assertEquals(LoginFields("jan", "s1", "", emptyList(), emptyList()), r.entries[0].fields)
        assertEquals("Poczta", r.entries[0].name)
    }

    @Test
    fun namesRowByUrlHost() {
        val r = NordPassCsv.parse("name,url\n,https://www.example.com/login\n,example.org/x\n,\n")
        assertEquals(listOf("example.com", "example.org"), r.entries.map { it.name })
        assertEquals(listOf(ImportSkip("wiersz 4", "brak nazwy i adresu")), r.skipped)
    }

    @Test
    fun typeColumnOverridesGuessing() {
        val r = NordPassCsv.parse("type,name,cardnumber,note\npassword,A,4111,\n,B,4111,\nnote,C,,tekst\n")
        assertEquals(listOf("login", "card", "note"), r.entries.map { it.fields.type })
        val r2 = NordPassCsv.parse("type,name,username\nPassword,A,jan\nNOTE,B,\n")
        assertEquals(listOf("login", "note"), r2.entries.map { it.fields.type })
    }

    @Test
    fun unknownTypeNamesAreSkipped() {
        val r = NordPassCsv.parse("type,name\nconstructor,A\n__proto__,B\ntoString,C\n")
        assertTrue(r.entries.isEmpty())
        assertEquals(
            listOf(
                ImportSkip("wiersz 2", "typ „constructor” nie jest obsługiwany"),
                ImportSkip("wiersz 3", "typ „__proto__” nie jest obsługiwany"),
                ImportSkip("wiersz 4", "typ „toString” nie jest obsługiwany"),
            ),
            r.skipped,
        )
    }

    @Test
    fun whitespaceOnlyPhoneAndEmailIgnored() {
        val f = NordPassCsv.parse("name,full_name,phone_number,email\nC,Jan Testowy,  ,\t\n").entries[0].fields as ContactFields
        assertTrue(f.phones.isEmpty())
        assertTrue(f.emails.isEmpty())
    }

    @Test
    fun keepsLoginWithoutPasswordAndExpiryAsWritten() {
        val r = NordPassCsv.parse("name,username,cardnumber,expirydate\nA,jan,,\nB,,4111,2030-12\n")
        assertEquals("login", r.entries[0].fields.type)
        assertEquals("2030-12", (r.entries[1].fields as CardFields).expiry)
    }

    @Test
    fun zipAndStateGoToCustomFields() {
        val r = NordPassCsv.parse("name,cardnumber,zipcode,full_name,state\nK,4111,00-001,,\nC,,,Jan Testowy,mazowieckie\n")
        assertEquals(listOf(CustomField("Kod pocztowy", "00-001", false)), r.entries[0].custom)
        assertEquals(listOf(CustomField("Województwo/stan", "mazowieckie", false)), r.entries[1].custom)
    }

    @Test
    fun exportMatchesVector() {
        val all = readExpected("passholder.expected.json").entries + readExpected("bitwarden.expected.json").entries
        assertEquals(readVector("export.nordpass.csv"), NordPassCsv.export(all))
    }

    @Test
    fun exportWritesHeaderAndSortedRows() {
        val rows = Csv.parse(NordPassCsv.export(listOf(note, login)))
        assertEquals(header, rows[0].fields.joinToString(","))
        assertEquals(listOf("name", "Notatka", "Poczta"), rows.map { it.fields[0] })
        assertTrue(rows.all { it.fields.size == 21 })
    }

    @Test
    fun roundTrips() {
        val entries = listOf(login, card, contact, note)
        assertEquals(ParsedImport(sortForExport(entries), emptyList()), NordPassCsv.parse(NordPassCsv.export(entries)))
    }

    @Test
    fun documentBecomesNoteLines() {
        val doc = EntryContentV3(
            "Paszport",
            "uwaga",
            DocumentFields(DocumentKind.PASSPORT, "AB123", "Jan Testowy", "2020-01-01", "2030-01-01", "Wojewoda"),
            listOf(CustomField("Sekret", "x", true)),
        )
        assertEquals(
            "uwaga\nRodzaj dokumentu: Paszport\nNumer: AB123\nImię i nazwisko: Jan Testowy\nData wydania: 2020-01-01\nData ważności: 2030-01-01\nWystawca: Wojewoda\nSekret: x",
            exportedRow(doc)["note"],
        )
        val bare = EntryContentV3("Paszport", "", DocumentFields(DocumentKind.ID_CARD, "", "", "", "", ""), emptyList())
        assertEquals("Rodzaj dokumentu: Dowód osobisty", exportedRow(bare)["note"])
    }

    @Test
    fun extrasGoToNote() {
        val lf = login.fields as LoginFields
        val l = login.copy(
            note = "",
            custom = listOf(CustomField("Pytanie", "Kolor?", false)),
            fields = lf.copy(urls = listOf("https://a.example.com", "https://b.example.com"), androidApps = listOf("com.example.app")),
        )
        assertEquals("https://a.example.com", exportedRow(l)["url"])
        assertEquals("Adres strony: https://b.example.com\nAplikacja Androida: com.example.app\nPytanie: Kolor?", exportedRow(l)["note"])
        assertEquals("PIN: 1234", exportedRow(card.copy(fields = (card.fields as CardFields).copy(pin = "1234")))["note"])
        val base = contact.fields as ContactFields
        val c = contact.copy(
            note = "n",
            fields = base.copy(
                birthDate = "1990-01-02",
                phones = base.phones + listOf(LabeledValue("dom", "600"), LabeledValue("", "700")),
                emails = base.emails + LabeledValue("praca", "p@example.com"),
                addresses = base.addresses + PostalAddress("biuro", "Długa 2", "", "Gdańsk", ""),
            ),
        )
        val row = exportedRow(c)
        assertEquals("Jan Maria Testowy", row["full_name"])
        assertEquals("500100200", row["phone_number"])
        assertEquals("ul. Przykładowa 1", row["address1"])
        assertEquals(
            "n\nTelefon (dom): 600\nTelefon: 700\nE-mail (praca): p@example.com\nAdres (biuro): Długa 2, Gdańsk\nData urodzenia: 1990-01-02",
            row["note"],
        )
    }
}
