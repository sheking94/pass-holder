package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.*
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class CommonTest {
    private fun note(name: String, text: String = "", custom: List<CustomField> = emptyList()) =
        EntryContentV3(name, text, NoteFields, custom)

    private fun login(name: String, fields: LoginFields = LoginFields("", "")) = EntryContentV3(name, "", fields, emptyList())

    @Test
    fun contentKeyIgnoresOuterSpacesNotInnerDifferences() {
        val a = note(" A ", "x")
        val b = note("A", "x ")
        assertEquals(contentKey(a), contentKey(b))
        assertNotEquals(contentKey(a), contentKey(note("A", "y")))
        assertNotEquals(contentKey(a), contentKey(note("A  B", "x")))
    }

    @Test
    fun contentKeyTrimsNestedTextsAndDistinguishesTypesAndHidden() {
        val l1 = EntryContentV3(" n ", "", LoginFields(" u ", "p", "", listOf(" https://a ")), listOf(CustomField(" l ", " v ", false)))
        val l2 = EntryContentV3("n", "", LoginFields("u", "p", "", listOf("https://a")), listOf(CustomField("l", "v", false)))
        assertEquals(contentKey(l1), contentKey(l2))
        assertNotEquals(contentKey(l2), contentKey(l2.copy(custom = listOf(CustomField("l", "v", true)))))
        assertNotEquals(contentKey(note("n")), contentKey(login("n")))
    }

    @Test
    fun sortsByPolishNameThenTypeWithoutMutatingInput() {
        val input = listOf(note("Łódź"), note("Lublin"), note("Same"), login("Same"), note("Zebra"))
        val copy = input.toList()
        val out = sortForExport(input)
        assertEquals(listOf("Lublin/note", "Łódź/note", "Same/login", "Same/note", "Zebra/note"), out.map { "${it.name}/${it.fields.type}" })
        assertEquals(copy, input)
        assertEquals(listOf("login", "contact", "card", "note", "document"), ENTRY_TYPE_ORDER)
    }

    @Test
    fun labelledAndAddressLine() {
        assertEquals("Telefon", labelled("Telefon", ""))
        assertEquals("Telefon (dom)", labelled("Telefon", "dom"))
        assertEquals("ul. A 1, 00-001 Warszawa, PL", addressLine(PostalAddress("", "ul. A 1", "00-001", "Warszawa", "PL")))
        assertEquals("Warszawa", addressLine(PostalAddress("x", "", "", "Warszawa", "")))
    }
}
