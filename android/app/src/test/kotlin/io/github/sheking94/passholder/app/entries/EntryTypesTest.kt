package io.github.sheking94.passholder.app.entries

import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.CustomField
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.DocumentKind
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.LabeledValue
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields
import io.github.sheking94.passholder.core.p2p.PostalAddress
import io.github.sheking94.passholder.core.transfer.DOCUMENT_KIND_NAMES
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EntryTypesTest {
    private fun card(number: String = "", expiry: String = "", name: String = "Visa") =
        EntryContent(name, "", CardFields("", number, expiry, "", ""), emptyList())

    private fun contact(
        birthDate: String = "",
        phones: List<LabeledValue> = emptyList(),
        emails: List<LabeledValue> = emptyList(),
        addresses: List<PostalAddress> = emptyList(),
        name: String = "Jan",
    ) = EntryContent(name, "", ContactFields("", "", birthDate, phones, emails, addresses), emptyList())

    private fun doc(kind: DocumentKind = DocumentKind.ID_CARD, issueDate: String = "", expiryDate: String = "", name: String = "Dowód") =
        EntryContent(name, "", DocumentFields(kind, "", "", issueDate, expiryDate, ""), emptyList())

    private fun login(
        username: String = "",
        password: String = "pw",
        urls: List<String> = emptyList(),
        apps: List<String> = emptyList(),
        name: String = "A",
        custom: List<CustomField> = emptyList(),
    ) = EntryContent(name, "", LoginFields(username, password, "", urls, apps), custom)

    private fun note(text: String) = EntryContent("N", text, NoteFields, emptyList())

    @Test fun typesInTabOrder() {
        assertEquals(
            listOf(EntryType.LOGIN, EntryType.CONTACT, EntryType.CARD, EntryType.NOTE, EntryType.DOCUMENT),
            EntryType.entries,
        )
        assertEquals("🔑", EntryType.LOGIN.icon)
        assertEquals("👤", EntryType.CONTACT.icon)
        assertEquals("💳", EntryType.CARD.icon)
        assertEquals("📝", EntryType.NOTE.icon)
        assertEquals("🪪", EntryType.DOCUMENT.icon)
        assertEquals(listOf("Loginy", "Kontakty", "Karty", "Notatki", "Dokumenty"), EntryType.entries.map { it.tab })
        assertEquals(
            listOf("Nowy login", "Nowy kontakt", "Nowa karta", "Nowa notatka", "Nowy dokument"),
            EntryType.entries.map { it.newTitle },
        )
        assertEquals(
            listOf("Edytuj login", "Edytuj kontakt", "Edytuj kartę", "Edytuj notatkę", "Edytuj dokument"),
            EntryType.entries.map { it.editTitle },
        )
    }

    @Test fun typeOfFields() {
        assertEquals(EntryType.LOGIN, EntryType.of(login().fields))
        assertEquals(EntryType.CONTACT, EntryType.of(contact().fields))
        assertEquals(EntryType.CARD, EntryType.of(card().fields))
        assertEquals(EntryType.NOTE, EntryType.of(NoteFields))
        assertEquals(EntryType.DOCUMENT, EntryType.of(doc().fields))
    }

    @Test fun documentKindLabels() {
        assertEquals("Dowód osobisty", DOCUMENT_KIND_NAMES[DocumentKind.ID_CARD])
        assertEquals("Paszport", DOCUMENT_KIND_NAMES[DocumentKind.PASSPORT])
        assertEquals("Prawo jazdy", DOCUMENT_KIND_NAMES[DocumentKind.DRIVING_LICENSE])
        assertEquals("Legitymacja", DOCUMENT_KIND_NAMES[DocumentKind.STUDENT_ID])
        assertEquals("Inny", DOCUMENT_KIND_NAMES[DocumentKind.OTHER])
        assertEquals(DocumentKind.entries.size, DOCUMENT_KIND_NAMES.size)
    }

    @Test fun summaryDescribesEachType() {
        assertEquals("•••• 1234", entrySummary(card("4111 1111 1111 1234")))
        assertEquals("•••• 12", entrySummary(card("12")))
        assertEquals("", entrySummary(card()))
        assertEquals("Paszport", entrySummary(doc(DocumentKind.PASSPORT)))
        assertEquals(
            "+48 600",
            entrySummary(contact(phones = listOf(LabeledValue("dom", "+48 600"), LabeledValue("x", "2")))),
        )
        assertEquals("", entrySummary(contact()))
        assertEquals("Pierwsza", entrySummary(note("\n  \nPierwsza\nDruga")))
        assertEquals("Pierwsza", entrySummary(note("\r\n\r\nPierwsza\r\nDruga")))
        assertEquals("jan", entrySummary(login(username = "jan")))
    }

    @Test fun matchesNameAndSummaryCaseInsensitively() {
        val c = card("1234 5678 9012 3456")
        assertTrue(matchesQuery(c, "3456"))
        assertTrue(matchesQuery(c, "VISA"))
        assertFalse(matchesQuery(c, "7777"))
        assertTrue(matchesQuery(c, ""))
        assertTrue(matchesQuery(c, "  visa  "))
        assertTrue(matchesQuery(contact(phones = listOf(LabeledValue("", "+48 600"))), "600"))
    }

    @Test fun tidyDropsEmptyItemsAndTrimsOnlyName() {
        val t = tidyContent(
            contact(phones = listOf(LabeledValue("", ""), LabeledValue("praca", "1")), name = "  X "),
        )
        assertEquals("X", t.name)
        assertEquals(listOf(LabeledValue("praca", "1")), (t.fields as ContactFields).phones)
        assertEquals(listOf("https://a.pl"), (tidyContent(login(urls = listOf("", "https://a.pl"))).fields as LoginFields).urls)
        assertEquals(emptyList<CustomField>(), tidyContent(login(custom = listOf(CustomField("", "", false)))).custom)
        assertEquals(emptyList<CustomField>(), tidyContent(login(custom = listOf(CustomField("", "", true)))).custom)
        assertEquals(" u", (tidyContent(login(username = " u")).fields as LoginFields).username)
        assertEquals(" a ", (tidyContent(login(password = " a ")).fields as LoginFields).password)
    }

    @Test fun tidyDropsEmptyAppsEmailsAddressesKeepsPartial() {
        assertEquals(
            listOf("pl.bank"),
            (tidyContent(login(apps = listOf("", "pl.bank", ""))).fields as LoginFields).androidApps,
        )
        val t = tidyContent(
            contact(
                emails = listOf(LabeledValue("", ""), LabeledValue("", "a@b.pl")),
                addresses = listOf(
                    PostalAddress("", "", "", "", ""),
                    PostalAddress("", "", "", "Kraków", ""),
                ),
            ),
        ).fields as ContactFields
        assertEquals(listOf(LabeledValue("", "a@b.pl")), t.emails)
        assertEquals(listOf(PostalAddress("", "", "", "Kraków", "")), t.addresses)
        val custom = listOf(CustomField("Tylko etykieta", "", false), CustomField("", "tylko wartość", true))
        assertEquals(custom, tidyContent(login(custom = custom)).custom)
    }

    @Test fun validatesNamePasswordAndFormats() {
        assertEquals("Podaj nazwę", validateContent(login(name = ""), null))
        assertEquals("Podaj nazwę", validateContent(login(name = "   "), null))
        assertEquals("Podaj albo wygeneruj hasło", validateContent(login(password = ""), null))
        assertEquals("Data urodzenia: wpisz datę RRRR-MM-DD", validateContent(contact("2026-02-30"), null))
        assertEquals("Data urodzenia: wpisz datę RRRR-MM-DD", validateContent(contact("1990-02-30"), null))
        assertNull(validateContent(contact("2028-02-29"), null))
        assertNull(validateContent(contact(""), null))
        assertEquals("Data ważności: wpisz datę RRRR-MM-DD", validateContent(doc(expiryDate = "30-01-2030"), null))
        assertEquals("Data wydania: wpisz datę RRRR-MM-DD", validateContent(doc(issueDate = "x"), null))
        assertEquals("Ważność: wpisz MM/RR", validateContent(card(expiry = "13/27"), null))
        assertNull(validateContent(card(expiry = "02/27"), null))
        assertEquals(
            "Aplikacje Androida: zła nazwa pakietu zla nazwa",
            validateContent(login(apps = listOf("zla nazwa")), null),
        )
        assertEquals("Aplikacje Androida: zła nazwa pakietu com", validateContent(login(apps = listOf("com")), null))
        assertNull(validateContent(login(apps = listOf("pl.mbank")), null))
        assertNull(validateContent(login(apps = listOf("com.example.app")), null))
        assertNull(validateContent(note(""), null))
    }

    @Test fun skipsUnchangedValuesFromOriginal() {
        val o = doc(expiryDate = "01.02.2030")
        assertNull(validateContent(o, o))
        assertEquals("Data ważności: wpisz datę RRRR-MM-DD", validateContent(doc(expiryDate = "02.02.2030"), o))
        val b = contact("01.02.1990")
        assertNull(validateContent(b, b))
        assertNull(validateContent(card(expiry = "2/2030"), card(expiry = "2/2030")))
        val l = login(apps = listOf("bad"))
        assertNull(validateContent(login(apps = listOf("bad")), l))
        assertEquals("Aplikacje Androida: zła nazwa pakietu x", validateContent(login(apps = listOf("bad", "x")), l))
    }

    @Test fun originalOfOtherTypeChecksEveryValue() {
        assertEquals("Ważność: wpisz MM/RR", validateContent(card(expiry = "2/2030"), doc()))
        assertEquals(
            "Data urodzenia: wpisz datę RRRR-MM-DD",
            validateContent(contact("01.02.1990"), card()),
        )
    }

    @Test fun emptyContentPerType() {
        for (t in EntryType.entries) {
            val c = emptyContent(t)
            assertEquals(t, EntryType.of(c.fields))
            assertEquals("", c.name)
            assertEquals("", c.note)
            assertEquals(emptyList<CustomField>(), c.custom)
        }
        assertEquals(DocumentKind.ID_CARD, (emptyContent(EntryType.DOCUMENT).fields as DocumentFields).kind)
        assertEquals(LoginFields("", ""), emptyContent(EntryType.LOGIN).fields)
        assertEquals(NoteFields, emptyContent(EntryType.NOTE).fields)
    }
}
