package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.StrictJson
import io.github.sheking94.passholder.core.StrictJson.appendQuoted
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.Attachments
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

enum class DocumentKind(val json: String) {
    ID_CARD("id_card"),
    PASSPORT("passport"),
    DRIVING_LICENSE("driving_license"),
    STUDENT_ID("student_id"),
    OTHER("other"),
}

data class LabeledValue(val label: String, val value: String)
data class PostalAddress(val label: String, val street: String, val postalCode: String, val city: String, val country: String)
data class CustomField(val label: String, val value: String, val hidden: Boolean)

sealed interface EntryFields {
    val type: String
}

data class LoginFields(
    val username: String,
    val password: String,
    val totp: String = "",
    val urls: List<String> = emptyList(),
    val androidApps: List<String> = emptyList(),
) : EntryFields {
    override val type get() = "login"
}

data class ContactFields(
    val firstName: String,
    val lastName: String,
    val birthDate: String,
    val phones: List<LabeledValue>,
    val emails: List<LabeledValue>,
    val addresses: List<PostalAddress>,
) : EntryFields {
    override val type get() = "contact"
}

data class CardFields(val holder: String, val number: String, val expiry: String, val cvc: String, val pin: String) : EntryFields {
    override val type get() = "card"
}

data object NoteFields : EntryFields {
    override val type get() = "note"
}

data class DocumentFields(
    val kind: DocumentKind,
    val number: String,
    val fullName: String,
    val issueDate: String,
    val expiryDate: String,
    val issuer: String,
) : EntryFields {
    override val type get() = "document"
}

data class EntryContent(
    val name: String,
    val note: String,
    val fields: EntryFields,
    val custom: List<CustomField>,
    val attachments: List<Attachment> = emptyList(),
)
data class EntryData(val content: EntryContent, val hlc: Hlc)
data class TombstoneData(val hlc: Hlc)

/** v3 entry model: strict parser, JS-compatible serializer and AES-GCM payload encryption bound to the entry id. */
object EntryCodec {
    const val MAX_BLOB_LENGTH = 65536

    private const val INVALID_ENTRY = "Invalid entry payload"
    private const val INVALID_TOMBSTONE = "Invalid tombstone payload"

    fun aad(id: String): String = "passholder/v2/entry/$id"

    // ---- serialization (compact JSON, fixed key order, escapes as JS JSON.stringify) ----

    fun serialize(data: EntryData): String {
        val c = data.content
        val sb = StringBuilder()
        sb.append("{\"v\":3,\"type\":")
        appendQuoted(sb, c.fields.type)
        sb.append(",\"name\":")
        appendQuoted(sb, c.name)
        sb.append(",\"note\":")
        appendQuoted(sb, c.note)
        sb.append(",\"fields\":")
        fields(sb, c.fields)
        sb.append(",\"custom\":")
        array(sb, c.custom) { s, f ->
            s.append("{\"label\":")
            appendQuoted(s, f.label)
            s.append(",\"value\":")
            appendQuoted(s, f.value)
            s.append(",\"hidden\":").append(f.hidden).append('}')
        }
        if (c.attachments.isNotEmpty()) {
            sb.append(",\"attachments\":")
            array(sb, c.attachments) { s, a ->
                s.append("{\"id\":")
                appendQuoted(s, a.id)
                s.append(",\"name\":")
                appendQuoted(s, a.name)
                s.append(",\"mime\":")
                appendQuoted(s, a.mime)
                s.append(",\"size\":").append(a.size)
                s.append(",\"chunks\":").append(a.chunks)
                s.append(",\"sha256\":")
                appendQuoted(s, a.sha256)
                s.append(",\"key\":")
                appendQuoted(s, a.key)
                s.append('}')
            }
        }
        sb.append(",\"hlc\":")
        hlc(sb, data.hlc)
        return sb.append('}').toString()
    }

    fun serializeTombstone(data: TombstoneData): String {
        val sb = StringBuilder("{\"hlc\":")
        hlc(sb, data.hlc)
        return sb.append('}').toString()
    }

    private fun hlc(sb: StringBuilder, h: Hlc) {
        sb.append("{\"ms\":").append(h.ms).append(",\"c\":").append(h.c).append(",\"d\":")
        appendQuoted(sb, h.d)
        sb.append('}')
    }

    private fun fields(sb: StringBuilder, f: EntryFields) {
        when (f) {
            is LoginFields -> {
                sb.append("{\"username\":")
                appendQuoted(sb, f.username)
                sb.append(",\"password\":")
                appendQuoted(sb, f.password)
                sb.append(",\"totp\":")
                appendQuoted(sb, f.totp)
                sb.append(",\"urls\":")
                array(sb, f.urls, ::appendQuoted)
                sb.append(",\"androidApps\":")
                array(sb, f.androidApps, ::appendQuoted)
                sb.append('}')
            }

            is ContactFields -> {
                sb.append("{\"firstName\":")
                appendQuoted(sb, f.firstName)
                sb.append(",\"lastName\":")
                appendQuoted(sb, f.lastName)
                sb.append(",\"birthDate\":")
                appendQuoted(sb, f.birthDate)
                sb.append(",\"phones\":")
                array(sb, f.phones, ::labeled)
                sb.append(",\"emails\":")
                array(sb, f.emails, ::labeled)
                sb.append(",\"addresses\":")
                array(sb, f.addresses) { s, a ->
                    s.append("{\"label\":")
                    appendQuoted(s, a.label)
                    s.append(",\"street\":")
                    appendQuoted(s, a.street)
                    s.append(",\"postalCode\":")
                    appendQuoted(s, a.postalCode)
                    s.append(",\"city\":")
                    appendQuoted(s, a.city)
                    s.append(",\"country\":")
                    appendQuoted(s, a.country)
                    s.append('}')
                }
                sb.append('}')
            }

            is CardFields -> {
                sb.append("{\"holder\":")
                appendQuoted(sb, f.holder)
                sb.append(",\"number\":")
                appendQuoted(sb, f.number)
                sb.append(",\"expiry\":")
                appendQuoted(sb, f.expiry)
                sb.append(",\"cvc\":")
                appendQuoted(sb, f.cvc)
                sb.append(",\"pin\":")
                appendQuoted(sb, f.pin)
                sb.append('}')
            }

            NoteFields -> sb.append("{}")

            is DocumentFields -> {
                sb.append("{\"kind\":")
                appendQuoted(sb, f.kind.json)
                sb.append(",\"number\":")
                appendQuoted(sb, f.number)
                sb.append(",\"fullName\":")
                appendQuoted(sb, f.fullName)
                sb.append(",\"issueDate\":")
                appendQuoted(sb, f.issueDate)
                sb.append(",\"expiryDate\":")
                appendQuoted(sb, f.expiryDate)
                sb.append(",\"issuer\":")
                appendQuoted(sb, f.issuer)
                sb.append('}')
            }
        }
    }

    private fun labeled(sb: StringBuilder, l: LabeledValue) {
        sb.append("{\"label\":")
        appendQuoted(sb, l.label)
        sb.append(",\"value\":")
        appendQuoted(sb, l.value)
        sb.append('}')
    }

    private fun <T> array(sb: StringBuilder, items: List<T>, item: (StringBuilder, T) -> Unit) {
        sb.append('[')
        items.forEachIndexed { i, x ->
            if (i > 0) sb.append(',')
            item(sb, x)
        }
        sb.append(']')
    }

    /** Length of the Base64 blob, computed without encrypting: 1 + 12 + n + 16 bytes. */
    fun blobLength(json: String): Int = 4 * ((29 + Encoding.utf8(json).size + 2) / 3)

    // ---- encryption ----

    fun encrypt(vaultKey: ByteArray, id: String, data: EntryData): String = sealChecked(vaultKey, id, serialize(data))

    fun encryptTombstone(vaultKey: ByteArray, id: String, data: TombstoneData): String = sealChecked(vaultKey, id, serializeTombstone(data))

    /** [nonce] is only for test vectors; [json] is the exact plaintext. */
    internal fun encryptJson(vaultKey: ByteArray, id: String, json: String, nonce: ByteArray): String =
        Aead.seal(vaultKey, Encoding.utf8(json), aad(id), nonce)

    private fun sealChecked(vaultKey: ByteArray, id: String, json: String): String {
        if (blobLength(json) > MAX_BLOB_LENGTH) throw PassHolderException(ErrorCode.ENTRY_TOO_LARGE, "Entry too large")
        return Aead.seal(vaultKey, Encoding.utf8(json), aad(id))
    }

    /** Throws [javax.crypto.AEADBadTagException] for a wrong key, id or changed blob. */
    fun decrypt(vaultKey: ByteArray, id: String, blob: String): JsonElement =
        P2pJson.json.parseToJsonElement(Encoding.fromUtf8(Aead.open(vaultKey, blob, aad(id))))

    // ---- strict parsing ----

    private fun fail(): Nothing = throw IllegalArgumentException(INVALID_ENTRY)

    private fun record(value: JsonElement?, vararg keys: String): JsonObject {
        if (value !is JsonObject || value.keys != keys.toSet()) fail()
        return value
    }

    private fun str(value: JsonElement?): String = StrictJson.string(value) ?: fail()

    private fun strings(value: JsonElement?): List<String> {
        if (value !is JsonArray) fail()
        return value.map(::str)
    }

    private fun <T> list(value: JsonElement?, item: (JsonElement) -> T): List<T> {
        if (value !is JsonArray) fail()
        return value.map(item)
    }

    private fun labeled(value: JsonElement): LabeledValue {
        val o = record(value, "label", "value")
        return LabeledValue(str(o["label"]), str(o["value"]))
    }

    private fun address(value: JsonElement): PostalAddress {
        val o = record(value, "label", "street", "postalCode", "city", "country")
        return PostalAddress(str(o["label"]), str(o["street"]), str(o["postalCode"]), str(o["city"]), str(o["country"]))
    }

    private fun customField(value: JsonElement): CustomField {
        val o = record(value, "label", "value", "hidden")
        val h = o["hidden"]
        val hidden = StrictJson.boolean(h)
        if (hidden == null) fail()
        return CustomField(str(o["label"]), str(o["value"]), hidden)
    }

    /** parseHlc ignores extra keys, so entries and tombstones check that the hlc object has exactly ms, c, d. */
    private fun strictHlc(value: JsonElement?, error: String): Hlc {
        if (value !is JsonObject || value.keys != setOf("ms", "c", "d")) throw IllegalArgumentException(error)
        return parseHlc(value)
    }

    private fun parseFields(type: String, raw: JsonElement?): EntryFields = when (type) {
        "login" -> {
            val o = record(raw, "username", "password", "totp", "urls", "androidApps")
            LoginFields(str(o["username"]), str(o["password"]), str(o["totp"]), strings(o["urls"]), strings(o["androidApps"]))
        }

        "contact" -> {
            val o = record(raw, "firstName", "lastName", "birthDate", "phones", "emails", "addresses")
            ContactFields(
                str(o["firstName"]),
                str(o["lastName"]),
                str(o["birthDate"]),
                list(o["phones"], ::labeled),
                list(o["emails"], ::labeled),
                list(o["addresses"], ::address),
            )
        }

        "card" -> {
            val o = record(raw, "holder", "number", "expiry", "cvc", "pin")
            CardFields(str(o["holder"]), str(o["number"]), str(o["expiry"]), str(o["cvc"]), str(o["pin"]))
        }

        "note" -> {
            record(raw)
            NoteFields
        }

        "document" -> {
            val o = record(raw, "kind", "number", "fullName", "issueDate", "expiryDate", "issuer")
            val kind = DocumentKind.entries.firstOrNull { it.json == str(o["kind"]) } ?: fail()
            DocumentFields(kind, str(o["number"]), str(o["fullName"]), str(o["issueDate"]), str(o["expiryDate"]), str(o["issuer"]))
        }

        else -> fail()
    }

    /** Accepts a v3 payload or a legacy v2 login payload (exactly name, username, password, hlc). */
    fun parse(value: JsonElement): EntryData {
        if (value !is JsonObject) fail()
        if (!value.containsKey("v")) {
            val o = record(value, "name", "username", "password", "hlc")
            val fields = LoginFields(str(o["username"]), str(o["password"]))
            return EntryData(
                EntryContent(str(o["name"]), "", fields, emptyList()),
                strictHlc(o["hlc"], INVALID_ENTRY),
            )
        }
        val withFiles = value.containsKey("attachments")
        val o = if (withFiles) {
            record(value, "v", "type", "name", "note", "fields", "custom", "attachments", "hlc")
        } else {
            record(value, "v", "type", "name", "note", "fields", "custom", "hlc")
        }
        val v = o["v"]
        if (v !is JsonPrimitive || v is JsonNull || v.isString || v.content != "3") fail()
        return EntryData(contentOf(o), strictHlc(o["hlc"], INVALID_ENTRY))
    }

    private fun contentOf(o: JsonObject): EntryContent = EntryContent(
        str(o["name"]),
        str(o["note"]),
        parseFields(str(o["type"]), o["fields"]),
        list(o["custom"], ::customField),
        if (o.containsKey("attachments")) Attachments.parseList(o["attachments"]) else emptyList(),
    )

    /** Entry content without the sync metadata: exactly type, name, note, fields and custom, validated as strictly as [parse]. */
    fun parseContent(value: JsonElement): EntryContent = contentOf(record(value, "type", "name", "note", "fields", "custom"))

    /** The content as a JSON tree: keys in the order type, name, note, fields, custom; fields in the order of [serialize]. */
    fun contentJson(c: EntryContent): JsonObject = JsonObject(
        linkedMapOf(
            "type" to JsonPrimitive(c.fields.type),
            "name" to JsonPrimitive(c.name),
            "note" to JsonPrimitive(c.note),
            "fields" to fieldsJson(c.fields),
            "custom" to JsonArray(
                c.custom.map {
                    obj("label" to JsonPrimitive(it.label), "value" to JsonPrimitive(it.value), "hidden" to JsonPrimitive(it.hidden))
                },
            ),
        ),
    )

    private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*pairs))
    private fun strs(l: List<String>) = JsonArray(l.map(::JsonPrimitive))
    private fun labeledJson(l: LabeledValue) = obj("label" to JsonPrimitive(l.label), "value" to JsonPrimitive(l.value))

    private fun fieldsJson(f: EntryFields): JsonObject = when (f) {
        is LoginFields -> obj(
            "username" to JsonPrimitive(f.username),
            "password" to JsonPrimitive(f.password),
            "totp" to JsonPrimitive(f.totp),
            "urls" to strs(f.urls),
            "androidApps" to strs(f.androidApps),
        )

        is ContactFields -> obj(
            "firstName" to JsonPrimitive(f.firstName),
            "lastName" to JsonPrimitive(f.lastName),
            "birthDate" to JsonPrimitive(f.birthDate),
            "phones" to JsonArray(f.phones.map(::labeledJson)),
            "emails" to JsonArray(f.emails.map(::labeledJson)),
            "addresses" to JsonArray(
                f.addresses.map {
                    obj(
                        "label" to JsonPrimitive(it.label),
                        "street" to JsonPrimitive(it.street),
                        "postalCode" to JsonPrimitive(it.postalCode),
                        "city" to JsonPrimitive(it.city),
                        "country" to JsonPrimitive(it.country),
                    )
                },
            ),
        )

        is CardFields -> obj(
            "holder" to JsonPrimitive(f.holder),
            "number" to JsonPrimitive(f.number),
            "expiry" to JsonPrimitive(f.expiry),
            "cvc" to JsonPrimitive(f.cvc),
            "pin" to JsonPrimitive(f.pin),
        )

        NoteFields -> obj()

        is DocumentFields -> obj(
            "kind" to JsonPrimitive(f.kind.json),
            "number" to JsonPrimitive(f.number),
            "fullName" to JsonPrimitive(f.fullName),
            "issueDate" to JsonPrimitive(f.issueDate),
            "expiryDate" to JsonPrimitive(f.expiryDate),
            "issuer" to JsonPrimitive(f.issuer),
        )
    }

    /** Exactly `{hlc}`. */
    fun parseTombstone(value: JsonElement): TombstoneData {
        if (value !is JsonObject || value.keys != setOf("hlc")) throw IllegalArgumentException(INVALID_TOMBSTONE)
        return TombstoneData(strictHlc(value["hlc"], INVALID_TOMBSTONE))
    }
}
