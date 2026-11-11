package io.github.sheking94.passholder.app.autofill

import android.text.InputType
import io.github.sheking94.passholder.core.autofill.FieldKind
import io.github.sheking94.passholder.core.autofill.FieldOption
import io.github.sheking94.passholder.core.autofill.classifyField
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NodeDescriptorTest {
    private fun attrs(
        hints: List<String> = emptyList(),
        htmlTag: String? = null,
        htmlAttrs: Map<String, String> = emptyMap(),
        inputType: Int = 0,
        idEntry: String? = null,
        hint: String? = null,
        contentDescription: String? = null,
        maxTextLength: Int = -1,
        options: List<String>? = null,
        isList: Boolean = false,
    ) = NodeAttrs(hints, htmlTag, htmlAttrs, inputType, idEntry, hint, contentDescription, maxTextLength, options, isList)

    @Test
    fun nativePasswordField() {
        val d = describeNode(attrs(inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD))
        assertEquals("password", d.type)
    }

    @Test
    fun nativePinField() {
        val d = describeNode(attrs(inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD))
        assertEquals("password", d.type)
    }

    @Test
    fun nativeEmailField() {
        val d = describeNode(attrs(inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS))
        assertEquals("email", d.type)
    }

    @Test
    fun htmlAutocompleteTokensPrecedeHints() {
        val d = describeNode(
            attrs(htmlAttrs = mapOf("autocomplete" to "section-a  cc-number"), hints = listOf("creditCardNumber")),
        )
        assertEquals(listOf("section-a", "cc-number", "creditCardNumber"), d.autocomplete)
    }

    @Test
    fun selectWithOptions() {
        val d = describeNode(attrs(htmlTag = "select", options = listOf("Jan", "Feb"), isList = true))
        assertEquals("select", d.type)
        assertEquals(listOf(FieldOption("Jan", "Jan"), FieldOption("Feb", "Feb")), d.options)
    }

    @Test
    fun idEntryFillsNameAndId() {
        val d = describeNode(attrs(idEntry = "login_field"))
        assertEquals("login_field", d.name)
        assertEquals("login_field", d.id)
        assertNull(d.options)
        assertNull(d.maxLength)
    }

    @Test
    fun htmlAttrsOverrideAndMaxLength() {
        val d = describeNode(
            attrs(
                htmlAttrs = mapOf("name" to "n", "id" to "i", "label" to "l", "placeholder" to "p", "maxlength" to "5", "type" to "tel"),
                idEntry = "x", hint = "h", contentDescription = "c", maxTextLength = 9,
            ),
        )
        assertEquals(listOf("n", "i", "l", "p", "tel", 5), listOf(d.name, d.id, d.label, d.placeholder, d.type, d.maxLength))
        assertEquals(7, describeNode(attrs(maxTextLength = 7)).maxLength)
    }

    @Test
    fun classifiesHintedPasswordField() {
        val d = describeNode(
            attrs(hint = "Hasło", inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD),
        )
        assertEquals(FieldKind.PASSWORD, classifyField(d))
    }
}
