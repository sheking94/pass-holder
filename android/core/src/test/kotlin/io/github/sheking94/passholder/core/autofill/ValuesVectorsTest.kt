package io.github.sheking94.passholder.core.autofill

import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.DocumentKind
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.NoteFields
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class ValuesVectorsTest {
    private fun plan(o: kotlinx.serialization.json.JsonObject): FillPlan = when (o.str("kind")) {
        "login" -> FillPlan.Login(o.str("username"), o.str("password"))

        "card" -> FillPlan.Card(o.str("holder"), o.str("number"), o.str("expiry"), o.str("cvc"))

        else -> FillPlan.Contact(
            o.str("firstName"), o.str("lastName"), o.str("email"), o.str("tel"),
            o.str("street"), o.str("postalCode"), o.str("city"), o.str("country"), o.str("bday"),
        )
    }

    @TestFactory
    fun valuesVectors(): List<DynamicTest> = readAutofillCases("values.json").mapIndexed { i, c ->
        DynamicTest.dynamicTest("case $i ${c["kind"]}") {
            val expected = if (c["expected"] is kotlinx.serialization.json.JsonNull) null else c.str("expected")
            val actual = fillValue(
                plan(c["plan"] as kotlinx.serialization.json.JsonObject),
                FieldKind.fromJson(c.str("kind")),
                c["field"].toFieldDescriptor(),
                c["hasUsernameField"]!!.toString() == "true",
            )
            assertEquals(expected, actual)
        }
    }

    private fun contact(birth: String = "", phones: List<io.github.sheking94.passholder.core.p2p.LabeledValue> = emptyList()) =
        EntryContentV3("c", "", ContactFields("A", "B", birth, phones, emptyList(), emptyList()), emptyList())

    @Test
    fun planForNoteAndDocumentIsNull() {
        assertNull(planFor(EntryContentV3("n", "", NoteFields, emptyList())))
        assertNull(planFor(EntryContentV3("d", "", DocumentFields(DocumentKind.entries.first(), "", "", "", "", ""), emptyList())))
    }

    @Test
    fun contactWithoutPhonesHasEmptyTel() {
        assertEquals("", (planFor(contact()) as FillPlan.Contact).tel)
    }

    @Test
    fun invalidCalendarBirthDateDropped() {
        assertEquals("", (planFor(contact("1990-02-30")) as FillPlan.Contact).bday)
        assertEquals("1990-02-28", (planFor(contact("1990-02-28")) as FillPlan.Contact).bday)
        assertTrue(planFor(contact()) is FillPlan.Contact)
    }
}
