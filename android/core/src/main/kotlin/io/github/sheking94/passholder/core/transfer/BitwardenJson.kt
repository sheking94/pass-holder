package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.FieldFormats
import io.github.sheking94.passholder.core.PassHolderException
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
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Bitwarden JSON (unencrypted) import and export; port of core/src/transfer/bitwarden-json.ts. */
object BitwardenJson {
    private const val ANDROID_PREFIX = "androidapp://"
    private val DOCUMENT_KINDS = DocumentKind.entries.associateBy { it.json }

    private const val L_KIND = DocumentLabels.KIND
    private const val L_NUMBER = "Numer dokumentu"
    private const val L_FULL_NAME = DocumentLabels.FULL_NAME
    private const val L_ISSUE = DocumentLabels.ISSUE_DATE
    private const val L_EXPIRY = DocumentLabels.EXPIRY_DATE
    private const val L_ISSUER = DocumentLabels.ISSUER
    private const val L_PIN = "PIN"

    /** True for an object with an `items` array (used to detect the file kind). */
    fun isFormat(value: JsonElement): Boolean = value is JsonObject && value["items"] is JsonArray

    // ---- JS-semantics helpers ----

    /** A JSON number as a double, or null for anything else (strings that look like numbers do not count). */
    private fun num(v: JsonElement?): Double? =
        if (v is JsonPrimitive && !v.isString && v !is JsonNull) v.content.toDoubleOrNull() else null

    /** JS String(number): integers without a fraction, otherwise Kotlin's shortest representation. */
    private fun numText(d: Double): String = if (d == Math.rint(d) &&
        Math.abs(d) < 1e21
    ) {
        (if (d == 0.0) "0" else java.math.BigDecimal(d).toBigInteger().toString())
    } else {
        d.toString()
    }

    /** null, booleans, arrays, objects and absent values become "". */
    private fun s(v: JsonElement?): String = when {
        v is JsonNull || v == null -> ""
        v is JsonPrimitive && v.isString -> v.content
        num(v) != null -> numText(num(v)!!)
        else -> ""
    }

    private fun obj(v: JsonElement?): JsonObject? = v as? JsonObject

    private fun custom(label: String, value: String, hidden: Boolean = false) = CustomField(label, value, hidden)

    private fun importFields(raw: JsonElement?): List<CustomField> {
        if (raw !is JsonArray) return emptyList()
        val out = mutableListOf<CustomField>()
        for (f in raw) {
            val o = obj(f) ?: continue
            when (num(o["type"])) {
                1.0 -> out.add(custom(s(o["name"]), s(o["value"]), true))
                2.0 -> out.add(custom(s(o["name"]), if (s(o["value"]) == "true") "true" else "false"))
                3.0 -> {}
                else -> out.add(custom(s(o["name"]), s(o["value"])))
            }
        }
        return out
    }

    private fun importCard(c: JsonObject, pin: String): CardFields {
        val month = s(c["expMonth"]).jsTrim()
        val year = s(c["expYear"]).jsTrim()
        return CardFields(
            holder = s(c["cardholderName"]),
            number = s(c["number"]),
            expiry = if (month != "" && year != "") "${month.padStart(2, '0')}/${year.takeLast(2)}" else "",
            cvc = s(c["code"]),
            pin = pin,
        )
    }

    private fun importIdentity(name: String, note: String, id: JsonObject, fields: List<CustomField>): EntryContent {
        val kindIdx = fields.indexOfFirst { it.label == L_KIND && it.value in DOCUMENT_KINDS }
        val isDocument = kindIdx >= 0
        val address = PostalAddress(
            label = "",
            street = listOf(s(id["address1"]), s(id["address2"]), s(id["address3"])).filter { it != "" }.joinToString(", "),
            postalCode = s(id["postalCode"]),
            city = s(id["city"]),
            country = s(id["country"]),
        )
        val hasAddress = listOf(address.label, address.street, address.postalCode, address.city, address.country).any { it != "" }
        val passport = s(id["passportNumber"])
        val license = s(id["licenseNumber"])
        val fullNameField = fields.firstOrNull { it.label == L_FULL_NAME }
        val hasFullName = fullNameField != null && fullNameField.value != ""
        // A document keeps one number (the one matching its kind first); the other one goes to a custom field.
        val kind = if (isDocument) DOCUMENT_KINDS.getValue(fields[kindIdx].value) else null
        val usesLicense = if (kind == DocumentKind.DRIVING_LICENSE) license != "" else passport == "" && license != ""
        val usesPassport = !usesLicense && passport != ""
        val numberFromIdentity = if (usesLicense) license else passport
        val extras = mutableListOf(
            "Tytuł" to s(id["title"]),
            "Drugie imię" to s(id["middleName"]),
            "Firma" to s(id["company"]),
            "Numer SSN" to s(id["ssn"]),
            "Numer paszportu" to (if (isDocument && usesPassport) "" else passport),
            "Numer prawa jazdy" to (if (isDocument && usesLicense) "" else license),
            "Nazwa użytkownika" to s(id["username"]),
            "Województwo/stan" to s(id["state"]),
        )
        if (isDocument) {
            extras.addAll(
                listOf(
                    "E-mail" to s(id["email"]),
                    "Telefon" to s(id["phone"]),
                    "Adres" to (if (hasAddress) addressLine(address) else ""),
                    "Imię" to (if (hasFullName) s(id["firstName"]) else ""),
                    "Nazwisko" to (if (hasFullName) s(id["lastName"]) else ""),
                ),
            )
        }
        val extraFields = extras.filter { it.second != "" }.map { custom(it.first, it.second) }
        val all = (extraFields + fields).toMutableList()

        if (isDocument) {
            all.removeAt(extraFields.size + kindIdx)
            fun take(label: String): String {
                val i = all.indexOfFirst { it.label == label }
                return if (i < 0) "" else all.removeAt(i).value
            }
            val number = numberFromIdentity.ifEmpty { take(L_NUMBER) }
            val fullName = take(L_FULL_NAME).ifEmpty { listOf(s(id["firstName"]), s(id["lastName"])).filter { it != "" }.joinToString(" ") }
            val issue = take(L_ISSUE)
            val expiry = take(L_EXPIRY)
            val issuer = take(L_ISSUER)
            return EntryContent(name, note, DocumentFields(kind!!, number, fullName, issue, expiry, issuer), all)
        }

        val email = s(id["email"])
        val phone = s(id["phone"])
        return EntryContent(
            name,
            note,
            ContactFields(
                firstName = s(id["firstName"]),
                lastName = s(id["lastName"]),
                birthDate = "",
                phones = if (phone != "") listOf(LabeledValue("", phone)) else emptyList(),
                emails = if (email != "") listOf(LabeledValue("", email)) else emptyList(),
                addresses = if (hasAddress) listOf(address) else emptyList(),
            ),
            all,
        )
    }

    /** An entry, or the Polish reason it is skipped. */
    private fun importItem(item: JsonObject): Any {
        val type = num(item["type"])
        if (type == null || type !in listOf(1.0, 2.0, 3.0, 4.0)) return "typ ${s(item["type"])} nie jest obsługiwany"
        val name = s(item["name"])
        if (name.jsTrim() == "") return SKIP_NO_NAME
        val note = s(item["notes"])
        val fields = importFields(item["fields"])
        return when (type) {
            1.0 -> {
                val login = obj(item["login"]) ?: JsonObject(emptyMap())
                val urls = mutableListOf<String>()
                val androidApps = mutableListOf<String>()
                for (u in (login["uris"] as? JsonArray) ?: emptyList()) {
                    val uri = obj(u)?.let { s(it["uri"]) } ?: ""
                    if (uri == "") continue
                    if (uri.startsWith(ANDROID_PREFIX)) androidApps.add(uri.removePrefix(ANDROID_PREFIX)) else urls.add(uri)
                }
                EntryContent(
                    name,
                    note,
                    LoginFields(s(login["username"]), s(login["password"]), s(login["totp"]), urls, androidApps),
                    fields,
                )
            }

            2.0 -> EntryContent(name, note, NoteFields, fields)

            3.0 -> {
                val card = obj(item["card"]) ?: JsonObject(emptyMap())
                val brand = s(card["brand"])
                val rest = fields.toMutableList()
                val pinIdx = rest.indexOfFirst { it.label == L_PIN }
                val pin = if (pinIdx < 0) "" else rest.removeAt(pinIdx).value
                EntryContent(
                    name,
                    note,
                    importCard(card, pin),
                    (if (brand != "") listOf(custom("Marka karty", brand)) else emptyList()) + rest,
                )
            }

            else -> importIdentity(name, note, obj(item["identity"]) ?: JsonObject(emptyMap()), fields)
        }
    }

    /** Throws [ErrorCode.IMPORT_BITWARDEN_ENCRYPTED] or [ErrorCode.IMPORT_NOT_BITWARDEN]; a bad item is skipped as "wpis N" (from 1). */
    fun parse(text: String): ParsedImport {
        val doc = try {
            Json.parseToJsonElement(text)
        } catch (e: SerializationException) {
            throw PassHolderException(ErrorCode.IMPORT_NOT_BITWARDEN, "Not a Bitwarden JSON file", cause = e)
        }
        if (doc is JsonObject) {
            val enc = doc["encrypted"]
            if (enc is JsonPrimitive && !enc.isString &&
                enc.content == "true"
            ) {
                throw PassHolderException(ErrorCode.IMPORT_BITWARDEN_ENCRYPTED)
            }
        }
        if (!isFormat(doc)) throw PassHolderException(ErrorCode.IMPORT_NOT_BITWARDEN, "Not a Bitwarden JSON file")
        val entries = mutableListOf<EntryContent>()
        val skipped = mutableListOf<ImportSkip>()
        ((doc as JsonObject)["items"] as JsonArray).forEachIndexed { i, item ->
            val r: Any = if (item is JsonObject) importItem(item) else SKIP_BAD_ENTRY
            if (r is String) skipped.add(ImportSkip("wpis ${i + 1}", r)) else entries.add(r as EntryContent)
        }
        return ParsedImport(entries, skipped)
    }

    // ---- export ----

    private fun nn(v: String): JsonElement = if (v == "") JsonNull else JsonPrimitive(v)
    private fun jo(vararg pairs: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*pairs))
    private fun field(name: String, value: String, hidden: Boolean = false) =
        jo("name" to JsonPrimitive(name), "value" to JsonPrimitive(value), "type" to JsonPrimitive(if (hidden) 1 else 0))

    private val EMPTY_IDENTITY: List<String> = listOf(
        "title", "firstName", "middleName", "lastName", "address1", "address2", "address3", "city", "state", "postalCode",
        "country", "company", "email", "phone", "ssn", "username", "passportNumber", "licenseNumber",
    )

    /** Identity object with every key null, in the fixed key order, then [values] overriding. */
    private fun identity(vararg values: Pair<String, JsonElement>): JsonObject {
        val map = LinkedHashMap<String, JsonElement>()
        EMPTY_IDENTITY.forEach { map[it] = JsonNull }
        values.forEach { map[it.first] = it.second }
        return JsonObject(map)
    }

    private fun exportItem(e: EntryContent): JsonObject {
        val extra = mutableListOf<JsonObject>()
        val type: Int
        val bodyKey: String
        val body: JsonElement
        when (val f = e.fields) {
            is LoginFields -> {
                type = 1
                bodyKey = "login"
                body = jo(
                    "uris" to JsonArray(
                        f.urls.map { jo("match" to JsonNull, "uri" to JsonPrimitive(it)) } +
                            f.androidApps.map { jo("match" to JsonNull, "uri" to JsonPrimitive(ANDROID_PREFIX + it)) },
                    ),
                    "username" to nn(f.username),
                    "password" to nn(f.password),
                    "totp" to nn(f.totp),
                )
            }

            is NoteFields -> {
                type = 2
                bodyKey = "secureNote"
                body = jo("type" to JsonPrimitive(0))
            }

            is CardFields -> {
                val m = FieldFormats.CARD_EXPIRY.matchEntire(f.expiry)
                type = 3
                bodyKey = "card"
                if (f.pin != "") extra.add(field(L_PIN, f.pin, true))
                if (m == null && f.expiry != "") extra.add(field("Ważność", f.expiry))
                body = jo(
                    "cardholderName" to nn(f.holder),
                    "brand" to JsonNull,
                    "number" to nn(f.number),
                    "expMonth" to (if (m != null) JsonPrimitive(m.groupValues[1].toInt().toString()) else JsonNull),
                    "expYear" to (if (m != null) JsonPrimitive("20${m.groupValues[2]}") else JsonNull),
                    "code" to nn(f.cvc),
                )
            }

            is ContactFields -> {
                val phone = f.phones.firstOrNull()
                val mail = f.emails.firstOrNull()
                val addr = f.addresses.firstOrNull()
                type = 4
                bodyKey = "identity"
                f.phones.drop(1).forEach { extra.add(field(labelled("Telefon", it.label), it.value)) }
                f.emails.drop(1).forEach { extra.add(field(labelled("E-mail", it.label), it.value)) }
                f.addresses.drop(1).forEach { extra.add(field(labelled("Adres", it.label), addressLine(it))) }
                if (f.birthDate != "") extra.add(field("Data urodzenia", f.birthDate))
                body = identity(
                    "firstName" to nn(f.firstName),
                    "lastName" to nn(f.lastName),
                    "phone" to (if (phone != null) nn(phone.value) else JsonNull),
                    "email" to (if (mail != null) nn(mail.value) else JsonNull),
                    "address1" to (if (addr != null) nn(addr.street) else JsonNull),
                    "postalCode" to (if (addr != null) nn(addr.postalCode) else JsonNull),
                    "city" to (if (addr != null) nn(addr.city) else JsonNull),
                    "country" to (if (addr != null) nn(addr.country) else JsonNull),
                )
            }

            is DocumentFields -> {
                type = 4
                bodyKey = "identity"
                extra.add(field(L_KIND, f.kind.json))
                if (f.kind != DocumentKind.PASSPORT && f.kind != DocumentKind.DRIVING_LICENSE && f.number != "") {
                    extra.add(field(L_NUMBER, f.number))
                }
                for ((label, value) in listOf(
                    L_FULL_NAME to f.fullName,
                    L_ISSUE to f.issueDate,
                    L_EXPIRY to f.expiryDate,
                    L_ISSUER to f.issuer,
                )) {
                    if (value != "") extra.add(field(label, value))
                }
                body = identity(
                    "passportNumber" to (if (f.kind == DocumentKind.PASSPORT) nn(f.number) else JsonNull),
                    "licenseNumber" to (if (f.kind == DocumentKind.DRIVING_LICENSE) nn(f.number) else JsonNull),
                )
            }
        }
        val fields = extra + e.custom.map { field(it.label, it.value, it.hidden) }
        return jo(
            "type" to JsonPrimitive(type),
            "name" to JsonPrimitive(e.name),
            "notes" to nn(e.note),
            "favorite" to JsonPrimitive(false),
            "fields" to JsonArray(fields),
            bodyKey to body,
        )
    }

    fun export(entries: List<EntryContent>): String {
        val doc = jo(
            "encrypted" to JsonPrimitive(false),
            "folders" to JsonArray(emptyList()),
            "items" to JsonArray(sortForExport(entries).map(::exportItem)),
        )
        return JsonText.stringify(doc) + "\n"
    }
}
