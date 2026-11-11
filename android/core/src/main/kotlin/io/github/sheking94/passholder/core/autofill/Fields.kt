package io.github.sheking94.passholder.core.autofill

import java.util.Locale

/** Port of core/src/autofill/fields.ts. */
data class FieldOption(val value: String, val text: String)

data class FieldDescriptor(
    /** autocomplete attribute tokens, or Android autofillHints */
    val autocomplete: List<String> = emptyList(),
    /** input type as in the DOM ("select" for a dropdown) */
    val type: String = "",
    val name: String = "",
    val id: String = "",
    val label: String = "",
    val placeholder: String = "",
    val maxLength: Int? = null,
    val options: List<FieldOption>? = null,
)

private val IGNORED_TYPES = setOf("hidden", "search", "submit", "button", "checkbox", "radio", "file")

fun classifyField(field: FieldDescriptor): FieldKind? {
    val type = field.type.lowercase(Locale.ROOT)
    if (type in IGNORED_TYPES) return null

    // Rule 1: autocomplete tokens; the last known token wins (section/shipping tokens come first).
    for (token in field.autocomplete.asReversed()) {
        val key = token.lowercase(Locale.ROOT)
        if (AUTOCOMPLETE_TOKENS.containsKey(key)) {
            val kind = AUTOCOMPLETE_TOKENS[key]
            return kind // null = skip
        }
    }

    val text = normalizeText("${field.name} ${field.id} ${field.label} ${field.placeholder}")
    // Rule 2: input type.
    if (type == "password") {
        return if (NEW_PASSWORD_PATTERN.containsMatchIn(text)) FieldKind.NEW_PASSWORD else FieldKind.PASSWORD
    }
    if (type == "email") return FieldKind.EMAIL
    if (type == "tel") return FieldKind.TEL

    if (SKIP_PATTERN.containsMatchIn(text)) return null
    // Rule 3: keywords. A non-password field that looks like new-password is skipped.
    val kind = KEYWORDS.firstOrNull { it.second.containsMatchIn(text) }?.first
    return if (kind == FieldKind.NEW_PASSWORD) null else kind
}
