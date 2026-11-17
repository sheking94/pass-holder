package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
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

    private val TYPES = mapOf("password" to "login", "note" to "note", "credit_card" to "card", "identity" to "contact")

    /** Columns that do not make a row more than a note when guessing the type. */
    private val NOTE_COLUMNS = setOf("name", "note", "folder", "shared_folder", "type")

    /** Host of a URL without "www.", or the text itself if it is not a URL. Used when a row has no name. */
    // Simplified host extraction: an IDN host stays Unicode (TS gives punycode) and invalid hosts are handled leniently.
    private fun nameFromUrl(url: String): String {
        val full = if (url.contains("://")) url else "https://$url"
        val rest = full.substringAfter("://")
        val authority = rest.takeWhile { it != '/' && it != '?' && it != '#' && it != '\\' }
        val hostPort = authority.substringAfterLast('@')
        val host = (if (hostPort.startsWith("[")) hostPort.substringBefore(']') + "]" else hostPort.substringBefore(':'))
        if (host.isEmpty() || host.any { it.isWhitespace() }) return url
        return host.lowercase().removePrefix("www.")
    }

    private fun extra(label: String, value: String) = CustomField(label, value, false)
    private fun filled(v: String) = v.jsTrim() != ""

    /** Throws [ErrorCode.IMPORT_EMPTY_FILE] or [ErrorCode.IMPORT_NOT_NORDPASS] (also the errors of [Csv.parse]); a row that cannot be taken is skipped as "wiersz N" (header is 1). */
    fun parse(text: String): ParsedImport {
        val all = Csv.parse(text)
        val header = all.firstOrNull() ?: throw PassHolderException(ErrorCode.IMPORT_EMPTY_FILE)
        val rows = all.drop(1)
        val index = LinkedHashMap<String, Int>()
        header.fields.forEachIndexed { i, name -> index[name.jsTrim().lowercase()] = i }
        if ("name" !in index &&
            "url" !in index
        ) {
            throw PassHolderException(ErrorCode.IMPORT_NOT_NORDPASS, "No name/url column in the first row")
        }

        val entries = mutableListOf<EntryContent>()
        val skipped = mutableListOf<ImportSkip>()
        for ((line, fields) in rows) {
            fun get(column: String): String = index[column]?.let { fields.getOrNull(it) } ?: ""
            val at = "wiersz $line"

            val declared = get("type").jsTrim()
            val kind: String = when {
                declared != "" -> TYPES[declared.lowercase()] ?: run {
                    skipped.add(ImportSkip(at, "typ „$declared” nie jest obsługiwany"))
                    null
                } ?: continue

                filled(get("cardnumber")) -> "card"

                listOf("full_name", "phone_number", "email", "address1").any { filled(get(it)) } -> "contact"

                index.keys.all { it in NOTE_COLUMNS || !filled(get(it)) } -> "note"

                else -> "login"
            }

            val url = get("url").jsTrim()
            val name = get("name").jsTrim().ifEmpty { if (url != "") nameFromUrl(url) else "" }
            if (name == "") {
                skipped.add(ImportSkip(at, "brak nazwy i adresu"))
                continue
            }
            val note = get("note")

            entries.add(
                when (kind) {
                    "login" -> EntryContent(
                        name,
                        note,
                        LoginFields(
                            get("username"),
                            get("password"),
                            get("totp"),
                            if (url !=
                                ""
                            ) {
                                listOf(url)
                            } else {
                                emptyList()
                            },
                            emptyList(),
                        ),
                        emptyList(),
                    )

                    "note" -> EntryContent(name, note, NoteFields, emptyList())

                    "card" -> EntryContent(
                        name,
                        note,
                        CardFields(get("cardholdername"), get("cardnumber"), get("expirydate"), get("cvc"), ""),
                        if (filled(get("zipcode"))) listOf(extra("Kod pocztowy", get("zipcode"))) else emptyList(),
                    )

                    else -> {
                        val fullName = get("full_name").jsTrim()
                        val space = fullName.indexOf(' ')
                        val street = listOf(get("address1"), get("address2")).filter(::filled).joinToString(", ")
                        val address = PostalAddress("", street, get("zipcode"), get("city"), get("country"))
                        val hasAddress = listOf("address1", "address2", "zipcode", "city", "country").any { filled(get(it)) }
                        EntryContent(
                            name,
                            note,
                            ContactFields(
                                firstName = if (space < 0) fullName else fullName.substring(0, space),
                                lastName = if (space < 0) "" else fullName.substring(space + 1).jsTrim(),
                                birthDate = "",
                                phones = if (filled(get("phone_number"))) listOf(LabeledValue("", get("phone_number"))) else emptyList(),
                                emails = if (filled(get("email"))) listOf(LabeledValue("", get("email"))) else emptyList(),
                                addresses = if (hasAddress) listOf(address) else emptyList(),
                            ),
                            if (filled(get("state"))) listOf(extra("Województwo/stan", get("state"))) else emptyList(),
                        )
                    }
                },
            )
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
