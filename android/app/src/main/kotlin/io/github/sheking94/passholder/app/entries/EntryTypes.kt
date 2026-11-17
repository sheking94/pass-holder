package io.github.sheking94.passholder.app.entries

import io.github.sheking94.passholder.core.FieldFormats
import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.DocumentKind
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.EntryFields
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields
import io.github.sheking94.passholder.core.transfer.DOCUMENT_KIND_NAMES

/** Entry types in tab order (logins first). Mirrors the browser extension's entry-types.ts. */
enum class EntryType(val icon: String, val tab: String, val newTitle: String, val editTitle: String) {
    LOGIN("🔑", "Loginy", "Nowy login", "Edytuj login"),
    CONTACT("👤", "Kontakty", "Nowy kontakt", "Edytuj kontakt"),
    CARD("💳", "Karty", "Nowa karta", "Edytuj kartę"),
    NOTE("📝", "Notatki", "Nowa notatka", "Edytuj notatkę"),
    DOCUMENT("🪪", "Dokumenty", "Nowy dokument", "Edytuj dokument"),
    ;

    companion object {
        fun of(fields: EntryFields): EntryType = when (fields) {
            is LoginFields -> LOGIN
            is ContactFields -> CONTACT
            is CardFields -> CARD
            NoteFields -> NOTE
            is DocumentFields -> DOCUMENT
        }
    }
}

private val ANDROID_PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
private val WHITESPACE = Regex("\\s")
private val LINE_BREAK = Regex("\\r?\\n")

fun emptyContent(type: EntryType): EntryContent {
    val fields: EntryFields = when (type) {
        EntryType.LOGIN -> LoginFields("", "")
        EntryType.CONTACT -> ContactFields("", "", "", emptyList(), emptyList(), emptyList())
        EntryType.CARD -> CardFields("", "", "", "", "")
        EntryType.NOTE -> NoteFields
        EntryType.DOCUMENT -> DocumentFields(DocumentKind.ID_CARD, "", "", "", "", "")
    }
    return EntryContent("", "", fields, emptyList())
}

/** Short description shown under the entry name in the list. */
fun entrySummary(content: EntryContent): String = when (val f = content.fields) {
    is LoginFields -> f.username

    is CardFields -> {
        val digits = f.number.replace(WHITESPACE, "")
        if (digits.isEmpty()) "" else "•••• " + digits.takeLast(4)
    }

    is DocumentFields -> DOCUMENT_KIND_NAMES[f.kind].orEmpty()

    is ContactFields -> f.phones.firstOrNull()?.value.orEmpty()

    NoteFields -> content.note.split(LINE_BREAK).firstOrNull { it.isNotBlank() }.orEmpty()
}

fun matchesQuery(content: EntryContent, query: String): Boolean =
    "${content.name} ${entrySummary(content)}".contains(query.trim(), ignoreCase = true)

/** Trims the name, drops list items whose text fields are all empty and empty custom fields. */
fun tidyContent(content: EntryContent): EntryContent {
    val fields = when (val f = content.fields) {
        is LoginFields -> f.copy(urls = f.urls.filter { it != "" }, androidApps = f.androidApps.filter { it != "" })

        is ContactFields -> f.copy(
            phones = f.phones.filter { it.label != "" || it.value != "" },
            emails = f.emails.filter { it.label != "" || it.value != "" },
            addresses = f.addresses.filter {
                it.label != "" || it.street != "" || it.postalCode != "" || it.city != "" || it.country != ""
            },
        )

        else -> f
    }
    return content.copy(
        name = content.name.trim(),
        fields = fields,
        custom = content.custom.filter { it.label != "" || it.value != "" },
    )
}

private fun validDate(value: String, original: String?): Boolean = value == "" || value == original || FieldFormats.isCalendarDate(value)

/** Returns the first form error, or null. Only values changed against [original] are format-checked. */
fun validateContent(content: EntryContent, original: EntryContent?): String? {
    if (content.name.trim() == "") return "Podaj nazwę"
    val before = original?.fields?.takeIf { EntryType.of(it) == EntryType.of(content.fields) }
    return when (val f = content.fields) {
        is LoginFields -> {
            if (f.password == "") return "Podaj albo wygeneruj hasło"
            val known = (before as? LoginFields)?.androidApps.orEmpty()
            f.androidApps.firstOrNull { it != "" && it !in known && !ANDROID_PACKAGE.matches(it) }
                ?.let { "Aplikacje Androida: zła nazwa pakietu $it" }
        }

        is ContactFields ->
            if (!validDate(f.birthDate, (before as? ContactFields)?.birthDate)) "Data urodzenia: wpisz datę RRRR-MM-DD" else null

        is DocumentFields -> {
            val o = before as? DocumentFields
            when {
                !validDate(f.issueDate, o?.issueDate) -> "Data wydania: wpisz datę RRRR-MM-DD"
                !validDate(f.expiryDate, o?.expiryDate) -> "Data ważności: wpisz datę RRRR-MM-DD"
                else -> null
            }
        }

        is CardFields -> {
            val o = (before as? CardFields)?.expiry
            if (f.expiry != "" && f.expiry != o && !FieldFormats.CARD_EXPIRY.matches(f.expiry)) "Ważność: wpisz MM/RR" else null
        }

        NoteFields -> null
    }
}
