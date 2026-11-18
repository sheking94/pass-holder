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
import io.github.sheking94.passholder.core.p2p.EntryFields
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

    /** Bitwarden item types (`item.type`). */
    private object ItemType {
        const val LOGIN = 1
        const val SECURE_NOTE = 2
        const val CARD = 3
        const val IDENTITY = 4
    }

    /** Bitwarden custom field types (`item.fields[].type`). */
    private object FieldType {
        const val TEXT = 0
        const val HIDDEN = 1
        const val BOOLEAN = 2
        const val LINKED = 3
    }

    /** Labels of the custom fields that carry PassHolder fields Bitwarden has no place for. */
    private object Labels {
        const val DOCUMENT_KIND = DocumentLabels.KIND
        const val DOCUMENT_NUMBER = "Numer dokumentu"
        const val FULL_NAME = DocumentLabels.FULL_NAME
        const val ISSUE_DATE = DocumentLabels.ISSUE_DATE
        const val EXPIRY_DATE = DocumentLabels.EXPIRY_DATE
        const val ISSUER = DocumentLabels.ISSUER
        const val PIN = "PIN"
    }

    /** True for an object with an `items` array (used to detect the file kind). */
    fun isFormat(value: JsonElement): Boolean = value is JsonObject && value["items"] is JsonArray

    // ---- JS-semantics helpers ----

    /** A JSON number as a double, or null for anything else (strings that look like numbers do not count). */
    private fun number(v: JsonElement?): Double? =
        if (v is JsonPrimitive && !v.isString && v !is JsonNull) v.content.toDoubleOrNull() else null

    /** A JSON number as a whole Int, or null for anything else. */
    private fun wholeNumber(v: JsonElement?): Int? = number(v)?.takeIf { it == Math.rint(it) && Math.abs(it) < 1e9 }?.toInt()

    /** JS String(number): integers without a fraction, otherwise Kotlin's shortest representation. */
    private fun numberText(d: Double): String = if (d == Math.rint(d) && Math.abs(d) < 1e21) {
        (if (d == 0.0) "0" else java.math.BigDecimal(d).toBigInteger().toString())
    } else {
        d.toString()
    }

    /** A text or number as text; null, booleans, arrays, objects and absent values become "". */
    private fun text(v: JsonElement?): String {
        val n = number(v)
        return when {
            v is JsonPrimitive && v.isString -> v.content
            n != null -> numberText(n)
            else -> ""
        }
    }

    private fun record(v: JsonElement?): JsonObject = v as? JsonObject ?: JsonObject(emptyMap())

    private fun custom(label: String, value: String, hidden: Boolean = false) = CustomField(label, value, hidden)

    /** Custom fields from (label, value) pairs, without the empty ones. */
    private fun filledCustom(pairs: List<Pair<String, String>>): List<CustomField> =
        pairs.filter { it.second != "" }.map { custom(it.first, it.second) }

    private fun importFields(raw: JsonElement?): List<CustomField> {
        if (raw !is JsonArray) return emptyList()
        val out = mutableListOf<CustomField>()
        for (f in raw) {
            val o = f as? JsonObject ?: continue
            when (wholeNumber(o["type"])) {
                FieldType.HIDDEN -> out.add(custom(text(o["name"]), text(o["value"]), true))
                FieldType.BOOLEAN -> out.add(custom(text(o["name"]), if (text(o["value"]) == "true") "true" else "false"))
                FieldType.LINKED -> {}
                else -> out.add(custom(text(o["name"]), text(o["value"])))
            }
        }
        return out
    }

    /** What every item brings: its name, note and custom fields. */
    private class ItemBase(val name: String, val note: String, val custom: List<CustomField>)

    /** An imported entry, or the Polish reason the item is skipped. */
    private sealed interface ItemResult {
        class Imported(val entry: EntryContent) : ItemResult
        class Skipped(val reason: String) : ItemResult
    }

    private fun importLogin(base: ItemBase, login: JsonObject): EntryContent {
        val urls = mutableListOf<String>()
        val androidApps = mutableListOf<String>()
        for (u in (login["uris"] as? JsonArray) ?: emptyList()) {
            val uri = (u as? JsonObject)?.let { text(it["uri"]) } ?: ""
            if (uri == "") continue
            if (uri.startsWith(ANDROID_PREFIX)) androidApps.add(uri.removePrefix(ANDROID_PREFIX)) else urls.add(uri)
        }
        val fields = LoginFields(text(login["username"]), text(login["password"]), text(login["totp"]), urls, androidApps)
        return EntryContent(base.name, base.note, fields, base.custom)
    }

    private fun importCard(base: ItemBase, card: JsonObject): EntryContent {
        val rest = base.custom.toMutableList()
        val pinIdx = rest.indexOfFirst { it.label == Labels.PIN }
        val pin = if (pinIdx < 0) "" else rest.removeAt(pinIdx).value
        val month = text(card["expMonth"]).jsTrim()
        val year = text(card["expYear"]).jsTrim()
        val fields = CardFields(
            holder = text(card["cardholderName"]),
            number = text(card["number"]),
            expiry = if (month != "" && year != "") "${month.padStart(2, '0')}/${year.takeLast(2)}" else "",
            cvc = text(card["code"]),
            pin = pin,
        )
        return EntryContent(base.name, base.note, fields, filledCustom(listOf("Marka karty" to text(card["brand"]))) + rest)
    }

    private fun identityAddress(id: JsonObject) = PostalAddress(
        label = "",
        street = listOf(text(id["address1"]), text(id["address2"]), text(id["address3"])).filter { it != "" }.joinToString(", "),
        postalCode = text(id["postalCode"]),
        city = text(id["city"]),
        country = text(id["country"]),
    )

    private fun hasAddress(a: PostalAddress): Boolean = listOf(a.label, a.street, a.postalCode, a.city, a.country).any { it != "" }

    /** Identity values PassHolder keeps as custom fields; the numbers are passed in, as a document may use one. */
    private fun identityExtras(id: JsonObject, passport: String, license: String): List<Pair<String, String>> = listOf(
        "Tytuł" to text(id["title"]),
        "Drugie imię" to text(id["middleName"]),
        "Firma" to text(id["company"]),
        "Numer SSN" to text(id["ssn"]),
        "Numer paszportu" to passport,
        "Numer prawa jazdy" to license,
        "Nazwa użytkownika" to text(id["username"]),
        "Województwo/stan" to text(id["state"]),
    )

    private fun importContact(base: ItemBase, id: JsonObject): EntryContent {
        val address = identityAddress(id)
        val email = text(id["email"])
        val phone = text(id["phone"])
        val extras = identityExtras(id, text(id["passportNumber"]), text(id["licenseNumber"]))
        return EntryContent(
            base.name,
            base.note,
            ContactFields(
                firstName = text(id["firstName"]),
                lastName = text(id["lastName"]),
                birthDate = "",
                phones = if (phone != "") listOf(LabeledValue("", phone)) else emptyList(),
                emails = if (email != "") listOf(LabeledValue("", email)) else emptyList(),
                addresses = if (hasAddress(address)) listOf(address) else emptyList(),
            ),
            filledCustom(extras) + base.custom,
        )
    }

    /** An identity whose custom field at [kindIndex] names document [kind] (as PassHolder exports documents). */
    private fun importDocument(base: ItemBase, id: JsonObject, kind: DocumentKind, kindIndex: Int): EntryContent {
        val passport = text(id["passportNumber"])
        val license = text(id["licenseNumber"])
        // A document keeps one number (the one matching its kind first); the other one goes to a custom field.
        val usesLicense = if (kind == DocumentKind.DRIVING_LICENSE) license != "" else passport == "" && license != ""
        val usesPassport = !usesLicense && passport != ""
        val address = identityAddress(id)
        val fullNameField = base.custom.firstOrNull { it.label == Labels.FULL_NAME }
        val hasFullName = fullNameField != null && fullNameField.value != ""
        val extras = identityExtras(id, if (usesPassport) "" else passport, if (usesLicense) "" else license) +
            listOf(
                "E-mail" to text(id["email"]),
                "Telefon" to text(id["phone"]),
                "Adres" to (if (hasAddress(address)) addressLine(address) else ""),
                "Imię" to (if (hasFullName) text(id["firstName"]) else ""),
                "Nazwisko" to (if (hasFullName) text(id["lastName"]) else ""),
            )
        val rest = (filledCustom(extras) + base.custom.filterIndexed { i, _ -> i != kindIndex }).toMutableList()
        fun take(label: String): String {
            val i = rest.indexOfFirst { it.label == label }
            return if (i < 0) "" else rest.removeAt(i).value
        }
        val number = (if (usesLicense) license else passport).ifEmpty { take(Labels.DOCUMENT_NUMBER) }
        val fullName = take(Labels.FULL_NAME).ifEmpty {
            listOf(text(id["firstName"]), text(id["lastName"])).filter { it != "" }.joinToString(" ")
        }
        val issueDate = take(Labels.ISSUE_DATE)
        val expiryDate = take(Labels.EXPIRY_DATE)
        val issuer = take(Labels.ISSUER)
        return EntryContent(base.name, base.note, DocumentFields(kind, number, fullName, issueDate, expiryDate, issuer), rest)
    }

    private fun importIdentity(base: ItemBase, id: JsonObject): EntryContent {
        val kindIndex = base.custom.indexOfFirst { it.label == Labels.DOCUMENT_KIND && it.value in DOCUMENT_KINDS }
        if (kindIndex < 0) return importContact(base, id)
        return importDocument(base, id, DOCUMENT_KINDS.getValue(base.custom[kindIndex].value), kindIndex)
    }

    private fun importItem(item: JsonObject): ItemResult {
        val type = wholeNumber(item["type"])
        if (type == null || type !in ItemType.LOGIN..ItemType.IDENTITY) {
            return ItemResult.Skipped("typ ${text(item["type"])} nie jest obsługiwany")
        }
        val name = text(item["name"])
        if (name.jsTrim() == "") return ItemResult.Skipped(SKIP_NO_NAME)
        val base = ItemBase(name, text(item["notes"]), importFields(item["fields"]))
        val entry = when (type) {
            ItemType.LOGIN -> importLogin(base, record(item["login"]))
            ItemType.SECURE_NOTE -> EntryContent(base.name, base.note, NoteFields, base.custom)
            ItemType.CARD -> importCard(base, record(item["card"]))
            else -> importIdentity(base, record(item["identity"]))
        }
        return ItemResult.Imported(entry)
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
            if (enc is JsonPrimitive && !enc.isString && enc.content == "true") {
                throw PassHolderException(ErrorCode.IMPORT_BITWARDEN_ENCRYPTED)
            }
        }
        if (!isFormat(doc)) throw PassHolderException(ErrorCode.IMPORT_NOT_BITWARDEN, "Not a Bitwarden JSON file")
        val entries = mutableListOf<EntryContent>()
        val skipped = mutableListOf<ImportSkip>()
        ((doc as JsonObject)["items"] as JsonArray).forEachIndexed { i, item ->
            when (val result = if (item is JsonObject) importItem(item) else ItemResult.Skipped(SKIP_BAD_ENTRY)) {
                is ItemResult.Imported -> entries.add(result.entry)
                is ItemResult.Skipped -> skipped.add(ImportSkip("wpis ${i + 1}", result.reason))
            }
        }
        return ParsedImport(entries, skipped)
    }

    // ---- export ----

    /** What one entry type adds to an item: its Bitwarden [type], its body under [bodyKey] and [extra] fields. */
    private class ItemParts(val type: Int, val bodyKey: String, val body: JsonObject, val extra: List<JsonObject>)

    /** Bitwarden writes null for an empty value. */
    private fun orNull(v: String): JsonElement = if (v == "") JsonNull else JsonPrimitive(v)
    private fun jsonObject(vararg pairs: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*pairs))
    private fun field(name: String, value: String, hidden: Boolean = false) = jsonObject(
        "name" to JsonPrimitive(name),
        "value" to JsonPrimitive(value),
        "type" to JsonPrimitive(if (hidden) FieldType.HIDDEN else FieldType.TEXT),
    )

    /** Fields from (label, value) pairs, without the empty ones. */
    private fun filledFields(pairs: List<Pair<String, String>>): List<JsonObject> =
        pairs.filter { it.second != "" }.map { field(it.first, it.second) }

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

    private fun exportLogin(f: LoginFields): ItemParts {
        val uris = (f.urls + f.androidApps.map { ANDROID_PREFIX + it }).map { jsonObject("match" to JsonNull, "uri" to JsonPrimitive(it)) }
        val login = jsonObject(
            "uris" to JsonArray(uris),
            "username" to orNull(f.username),
            "password" to orNull(f.password),
            "totp" to orNull(f.totp),
        )
        return ItemParts(ItemType.LOGIN, "login", login, emptyList())
    }

    private fun exportCard(f: CardFields): ItemParts {
        val m = FieldFormats.CARD_EXPIRY.matchEntire(f.expiry)
        val extra = mutableListOf<JsonObject>()
        if (f.pin != "") extra.add(field(Labels.PIN, f.pin, true))
        if (m == null && f.expiry != "") extra.add(field("Ważność", f.expiry))
        val card = jsonObject(
            "cardholderName" to orNull(f.holder),
            "brand" to JsonNull,
            "number" to orNull(f.number),
            "expMonth" to (if (m != null) JsonPrimitive(m.groupValues[1].toInt().toString()) else JsonNull),
            "expYear" to (if (m != null) JsonPrimitive("20${m.groupValues[2]}") else JsonNull),
            "code" to orNull(f.cvc),
        )
        return ItemParts(ItemType.CARD, "card", card, extra)
    }

    private fun exportContact(f: ContactFields): ItemParts {
        val phone = f.phones.firstOrNull()
        val mail = f.emails.firstOrNull()
        val addr = f.addresses.firstOrNull()
        val extra = f.phones.drop(1).map { field(labelled("Telefon", it.label), it.value) } +
            f.emails.drop(1).map { field(labelled("E-mail", it.label), it.value) } +
            f.addresses.drop(1).map { field(labelled("Adres", it.label), addressLine(it)) } +
            filledFields(listOf("Data urodzenia" to f.birthDate))
        val body = identity(
            "firstName" to orNull(f.firstName),
            "lastName" to orNull(f.lastName),
            "phone" to (if (phone != null) orNull(phone.value) else JsonNull),
            "email" to (if (mail != null) orNull(mail.value) else JsonNull),
            "address1" to (if (addr != null) orNull(addr.street) else JsonNull),
            "postalCode" to (if (addr != null) orNull(addr.postalCode) else JsonNull),
            "city" to (if (addr != null) orNull(addr.city) else JsonNull),
            "country" to (if (addr != null) orNull(addr.country) else JsonNull),
        )
        return ItemParts(ItemType.IDENTITY, "identity", body, extra)
    }

    /** A document is an identity: its kind and fields go to custom fields, passport and licence numbers to theirs. */
    private fun exportDocument(f: DocumentFields): ItemParts {
        val ownNumberField = f.kind == DocumentKind.PASSPORT || f.kind == DocumentKind.DRIVING_LICENSE
        val extra = listOf(field(Labels.DOCUMENT_KIND, f.kind.json)) +
            filledFields(
                listOf(
                    Labels.DOCUMENT_NUMBER to (if (ownNumberField) "" else f.number),
                    Labels.FULL_NAME to f.fullName,
                    Labels.ISSUE_DATE to f.issueDate,
                    Labels.EXPIRY_DATE to f.expiryDate,
                    Labels.ISSUER to f.issuer,
                ),
            )
        val body = identity(
            "passportNumber" to (if (f.kind == DocumentKind.PASSPORT) orNull(f.number) else JsonNull),
            "licenseNumber" to (if (f.kind == DocumentKind.DRIVING_LICENSE) orNull(f.number) else JsonNull),
        )
        return ItemParts(ItemType.IDENTITY, "identity", body, extra)
    }

    private fun itemParts(fields: EntryFields): ItemParts = when (fields) {
        is LoginFields -> exportLogin(fields)
        is NoteFields -> ItemParts(ItemType.SECURE_NOTE, "secureNote", jsonObject("type" to JsonPrimitive(0)), emptyList())
        is CardFields -> exportCard(fields)
        is ContactFields -> exportContact(fields)
        is DocumentFields -> exportDocument(fields)
    }

    private fun exportItem(e: EntryContent): JsonObject {
        val parts = itemParts(e.fields)
        val fields = parts.extra + e.custom.map { field(it.label, it.value, it.hidden) }
        return jsonObject(
            "type" to JsonPrimitive(parts.type),
            "name" to JsonPrimitive(e.name),
            "notes" to orNull(e.note),
            "favorite" to JsonPrimitive(false),
            "fields" to JsonArray(fields),
            parts.bodyKey to parts.body,
        )
    }

    fun export(entries: List<EntryContent>): String {
        val doc = jsonObject(
            "encrypted" to JsonPrimitive(false),
            "folders" to JsonArray(emptyList()),
            "items" to JsonArray(sortForExport(entries).map(::exportItem)),
        )
        return JsonText.stringify(doc) + "\n"
    }
}
