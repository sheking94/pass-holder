package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.hostOf
import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.CustomField
import io.github.sheking94.passholder.core.p2p.DocumentFields
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.LabeledValue
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.NoteFields
import io.github.sheking94.passholder.core.p2p.PostalAddress

/** NordPass CSV import and export; port of core/src/transfer/nordpass-csv.ts. */
object NordPassCsv {
    /** NordPass export header, in its order. Import finds columns by name, so the order there does not matter. */
    val COLUMNS: List<String> = listOf(
        "name", "url", "username", "password", "note", "cardholdername", "cardnumber", "cvc", "expirydate", "zipcode",
        "folder", "full_name", "phone_number", "email", "address1", "address2", "city", "country", "state", "totp",
        "shared_folder",
    )

    private enum class Kind { LOGIN, NOTE, CARD, CONTACT }

    private val TYPES = mapOf("password" to Kind.LOGIN, "note" to Kind.NOTE, "credit_card" to Kind.CARD, "identity" to Kind.CONTACT)

    /** Columns that do not make a row more than a note when guessing the type. */
    private val NOTE_COLUMNS = setOf("name", "note", "folder", "shared_folder", "type")
    private val CONTACT_COLUMNS = listOf("full_name", "phone_number", "email", "address1")
    private val ADDRESS_COLUMNS = listOf("address1", "address2", "zipcode", "city", "country")

    /** One CSV row: the text of a column, "" when the file has no such column. */
    private class Row(private val index: Map<String, Int>, private val fields: List<String>) {
        operator fun get(column: String): String = index[column]?.let { fields.getOrNull(it) } ?: ""
    }

    /** The entry type of a row, or the Polish reason it is skipped. */
    private sealed interface Guess {
        data class Known(val kind: Kind) : Guess
        data class Skip(val reason: String) : Guess
    }

    /** Host of a URL (see [hostOf]), or the text itself if it has none. Used when a row has no name. */
    private fun nameFromUrl(url: String): String = hostOf(url) ?: url

    private fun extra(label: String, value: String) = CustomField(label, value, false)
    private fun filled(v: String) = v.jsTrim() != ""

    /** The declared "type" column, else a guess from the filled columns ([columns]: all columns of the file). */
    private fun guessKind(row: Row, columns: Collection<String>): Guess {
        val declared = row["type"].jsTrim()
        if (declared != "") {
            val kind = TYPES[declared.lowercase()] ?: return Guess.Skip("typ „$declared” nie jest obsługiwany")
            return Guess.Known(kind)
        }
        return Guess.Known(
            when {
                filled(row["cardnumber"]) -> Kind.CARD
                CONTACT_COLUMNS.any { filled(row[it]) } -> Kind.CONTACT
                columns.all { it in NOTE_COLUMNS || !filled(row[it]) } -> Kind.NOTE
                else -> Kind.LOGIN
            },
        )
    }

    private fun contactFields(row: Row): ContactFields {
        val fullName = row["full_name"].jsTrim()
        val space = fullName.indexOf(' ')
        val street = listOf(row["address1"], row["address2"]).filter(::filled).joinToString(", ")
        val address = PostalAddress("", street, row["zipcode"], row["city"], row["country"])
        val hasAddress = ADDRESS_COLUMNS.any { filled(row[it]) }
        return ContactFields(
            firstName = if (space < 0) fullName else fullName.substring(0, space),
            lastName = if (space < 0) "" else fullName.substring(space + 1).jsTrim(),
            birthDate = "",
            phones = if (filled(row["phone_number"])) listOf(LabeledValue("", row["phone_number"])) else emptyList(),
            emails = if (filled(row["email"])) listOf(LabeledValue("", row["email"])) else emptyList(),
            addresses = if (hasAddress) listOf(address) else emptyList(),
        )
    }

    /** The entry of a row of the given [kind], named [name]. */
    private fun rowToEntry(row: Row, kind: Kind, name: String): EntryContent {
        val note = row["note"]
        return when (kind) {
            Kind.LOGIN -> {
                val url = row["url"].jsTrim()
                val urls = if (url != "") listOf(url) else emptyList()
                EntryContent(name, note, LoginFields(row["username"], row["password"], row["totp"], urls, emptyList()), emptyList())
            }

            Kind.NOTE -> EntryContent(name, note, NoteFields, emptyList())

            Kind.CARD -> EntryContent(
                name,
                note,
                CardFields(row["cardholdername"], row["cardnumber"], row["expirydate"], row["cvc"], ""),
                if (filled(row["zipcode"])) listOf(extra("Kod pocztowy", row["zipcode"])) else emptyList(),
            )

            Kind.CONTACT -> EntryContent(
                name,
                note,
                contactFields(row),
                if (filled(row["state"])) listOf(extra("Województwo/stan", row["state"])) else emptyList(),
            )
        }
    }

    /** Throws [ErrorCode.IMPORT_EMPTY_FILE] or [ErrorCode.IMPORT_NOT_NORDPASS] (also the errors of [Csv.parse]); a row that cannot be taken is skipped as "wiersz N" (header is 1). */
    fun parse(text: String): ParsedImport {
        val all = Csv.parse(text)
        val header = all.firstOrNull() ?: throw PassHolderException(ErrorCode.IMPORT_EMPTY_FILE)
        val index = LinkedHashMap<String, Int>()
        header.fields.forEachIndexed { i, name -> index[name.jsTrim().lowercase()] = i }
        if ("name" !in index && "url" !in index) {
            throw PassHolderException(ErrorCode.IMPORT_NOT_NORDPASS, "No name/url column in the first row")
        }

        val entries = mutableListOf<EntryContent>()
        val skipped = mutableListOf<ImportSkip>()
        for ((line, fields) in all.drop(1)) {
            val row = Row(index, fields)
            val at = "wiersz $line"
            val kind = when (val guess = guessKind(row, index.keys)) {
                is Guess.Skip -> {
                    skipped.add(ImportSkip(at, guess.reason))
                    continue
                }

                is Guess.Known -> guess.kind
            }
            val url = row["url"].jsTrim()
            val name = row["name"].jsTrim().ifEmpty { if (url != "") nameFromUrl(url) else "" }
            if (name == "") {
                skipped.add(ImportSkip(at, "brak nazwy i adresu"))
                continue
            }
            entries.add(rowToEntry(row, kind, name))
        }
        return ParsedImport(entries, skipped)
    }

    // ---- export ----

    private fun line(label: String, value: String): List<String> = if (value == "") emptyList() else listOf("$label: $value")

    private fun exportRow(e: EntryContent): List<String> {
        val v = mutableMapOf("name" to e.name)
        val lines = mutableListOf<String>()
        when (val f = e.fields) {
            is LoginFields -> {
                v["url"] = f.urls.firstOrNull() ?: ""
                v["username"] = f.username
                v["password"] = f.password
                v["totp"] = f.totp
                f.urls.drop(1).forEach { lines += line("Adres strony", it) }
                f.androidApps.forEach { lines += line("Aplikacja Androida", it) }
            }

            is CardFields -> {
                v["cardholdername"] = f.holder
                v["cardnumber"] = f.number
                v["cvc"] = f.cvc
                v["expirydate"] = f.expiry
                lines += line("PIN", f.pin)
            }

            is ContactFields -> {
                v["full_name"] = "${f.firstName} ${f.lastName}".jsTrim()
                v["phone_number"] = f.phones.firstOrNull()?.value ?: ""
                v["email"] = f.emails.firstOrNull()?.value ?: ""
                f.addresses.firstOrNull()?.let {
                    v["address1"] = it.street
                    v["zipcode"] = it.postalCode
                    v["city"] = it.city
                    v["country"] = it.country
                }
                f.phones.drop(1).forEach { lines += line(labelled("Telefon", it.label), it.value) }
                f.emails.drop(1).forEach { lines += line(labelled("E-mail", it.label), it.value) }
                f.addresses.drop(1).forEach { lines += line(labelled("Adres", it.label), addressLine(it)) }
                lines += line("Data urodzenia", f.birthDate)
            }

            is NoteFields -> {}

            is DocumentFields -> {
                lines += line(DocumentLabels.KIND, DOCUMENT_KIND_NAMES[f.kind] ?: "")
                lines += line("Numer", f.number)
                lines += line(DocumentLabels.FULL_NAME, f.fullName)
                lines += line(DocumentLabels.ISSUE_DATE, f.issueDate)
                lines += line(DocumentLabels.EXPIRY_DATE, f.expiryDate)
                lines += line(DocumentLabels.ISSUER, f.issuer)
            }
        }
        e.custom.forEach { lines += line(it.label, it.value) }
        v["note"] = ((if (e.note == "") emptyList() else listOf(e.note)) + lines).joinToString("\n")
        return COLUMNS.map { v[it] ?: "" }
    }

    fun export(entries: List<EntryContent>): String = Csv.write(listOf(COLUMNS) + sortForExport(entries).map(::exportRow))
}
