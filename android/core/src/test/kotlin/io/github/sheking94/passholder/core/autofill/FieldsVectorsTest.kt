package io.github.sheking94.passholder.core.autofill

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class FieldsVectorsTest {
    @TestFactory
    fun fieldsVectors(): List<DynamicTest> = readAutofillCases("fields.json").mapIndexed { i, c ->
        DynamicTest.dynamicTest("case $i ${c["field"]}") {
            val expected = c.str("expected").ifEmpty { null }
            assertEquals(expected, classifyField(c["field"].toFieldDescriptor())?.json)
        }
    }

    @Test
    fun normalizeStripsDiacriticsAndStrokedL() {
        assertEquals("lodz waznosc", normalizeText("Łódź Ważność"))
    }
}
