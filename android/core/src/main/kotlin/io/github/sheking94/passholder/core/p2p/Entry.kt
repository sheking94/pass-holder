package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.KIB
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
    const val MAX_BLOB_LENGTH = 64 * KIB

    private const val INVALID_ENTRY = "Invalid entry payload"
    private const val INVALID_TOMBSTONE = "Invalid tombstone payload"

    fun aad(id: String): String = "passholder/v2/entry/$id"

    // ---- serialization (compact JSON, fixed key order, escapes as JS JSON.stringify) ----

    fun serialize(data: EntryData): String {
        val content = data.content
        val out = StringBuilder()
        out.append("{\"v\":3,\"type\":")
        appendQuoted(out, content.fields.type)
        out.append(",\"name\":")
        appendQuoted(out, content.name)
        out.append(",\"note\":")
        appendQuoted(out, content.note)
        out.append(",\"fields\":")
        appendJson(out, fieldsJson(content.fields))
        out.append(",\"custom\":")
        appendJson(out, customJson(content.custom))
        if (content.attachments.isNotEmpty()) {
            out.append(",\"attachments\":")
            appendJson(out, JsonArray(content.attachments.map(::attachmentJson)))
        }
        out.append(",\"hlc\":")
        appendHlc(out, data.hlc)
        return out.append('}').toString()
    }

    fun serializeTombstone(data: TombstoneData): String {
        val out = StringBuilder("{\"hlc\":")
        appendHlc(out, data.hlc)
        return out.append('}').toString()
    }

    private fun appendHlc(out: StringBuilder, hlc: Hlc) {
        out.append("{\"ms\":").append(hlc.ms).append(",\"c\":").append(hlc.c).append(",\"d\":")
        appendQuoted(out, hlc.d)
        out.append('}')
    }

    /** Compact JSON as JS JSON.stringify writes it: keys in the tree's order, strings escaped by [appendQuoted]. */
    private fun appendJson(out: StringBuilder, value: JsonElement) {
        when (value) {
            is JsonObject -> {
                out.append('{')
                value.entries.forEachIndexed { i, (key, item) ->
                    if (i > 0) out.append(',')
                    appendQuoted(out, key)
                    out.append(':')
                    appendJson(out, item)
                }
                out.append('}')
            }

            is JsonArray -> {
                out.append('[')
                value.forEachIndexed { i, item ->
                    if (i > 0) out.append(',')
                    appendJson(out, item)
                }
                out.append(']')
            }

            is JsonPrimitive -> if (value.isString) appendQuoted(out, value.content) else out.append(value.content)
        }
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

    /** Reads one fields object; every key read is noted, so [requireAllRead] can refuse keys no field has. */
    private class FieldReader(private val obj: JsonObject) {
        private val read = HashSet<String>()

        private fun value(key: String): JsonElement? {
            read.add(key)
            return obj[key]
        }

        fun text(key: String): String = str(value(key))
        fun texts(key: String): List<String> = strings(value(key))
        fun labeledValues(key: String): List<LabeledValue> = list(value(key), ::labeled)
        fun addresses(key: String): List<PostalAddress> = list(value(key), ::address)
        fun documentKind(key: String): DocumentKind =
            text(key).let { json -> DocumentKind.entries.firstOrNull { it.json == json } } ?: fail()

        fun requireAllRead() {
            if (obj.keys != read) fail()
        }
    }

    /**
     * The fields of one entry type, described once (review V3 CW6): [write] gives the JSON object in serialization
     * order, [read] builds the fields from a [FieldReader] (a missing, extra or wrongly typed key fails).
     */
    private class FieldsSpec<F : EntryFields>(val write: (F) -> JsonObject, val read: (FieldReader) -> F)

    private fun textJson(value: String) = JsonPrimitive(value)
    private fun textsJson(values: List<String>) = JsonArray(values.map(::JsonPrimitive))
    private fun labeledJson(value: LabeledValue) = jsonObject("label" to textJson(value.label), "value" to textJson(value.value))
    private fun addressJson(value: PostalAddress) = jsonObject(
        "label" to textJson(value.label),
        "street" to textJson(value.street),
        "postalCode" to textJson(value.postalCode),
        "city" to textJson(value.city),
        "country" to textJson(value.country),
    )

    private val LOGIN = FieldsSpec<LoginFields>(
        write = {
            jsonObject(
                "username" to textJson(it.username),
                "password" to textJson(it.password),
                "totp" to textJson(it.totp),
                "urls" to textsJson(it.urls),
                "androidApps" to textsJson(it.androidApps),
            )
        },
        read = { LoginFields(it.text("username"), it.text("password"), it.text("totp"), it.texts("urls"), it.texts("androidApps")) },
    )

    private val CONTACT = FieldsSpec<ContactFields>(
        write = {
            jsonObject(
                "firstName" to textJson(it.firstName),
                "lastName" to textJson(it.lastName),
                "birthDate" to textJson(it.birthDate),
                "phones" to JsonArray(it.phones.map(::labeledJson)),
                "emails" to JsonArray(it.emails.map(::labeledJson)),
                "addresses" to JsonArray(it.addresses.map(::addressJson)),
            )
        },
        read = {
            ContactFields(
                it.text("firstName"),
                it.text("lastName"),
                it.text("birthDate"),
                it.labeledValues("phones"),
                it.labeledValues("emails"),
                it.addresses("addresses"),
            )
        },
    )

    private val CARD = FieldsSpec<CardFields>(
        write = {
            jsonObject(
                "holder" to textJson(it.holder),
                "number" to textJson(it.number),
                "expiry" to textJson(it.expiry),
                "cvc" to textJson(it.cvc),
                "pin" to textJson(it.pin),
            )
        },
        read = { CardFields(it.text("holder"), it.text("number"), it.text("expiry"), it.text("cvc"), it.text("pin")) },
    )

    private val NOTE = FieldsSpec<NoteFields>(write = { jsonObject() }, read = { NoteFields })

    private val DOCUMENT = FieldsSpec<DocumentFields>(
        write = {
            jsonObject(
                "kind" to textJson(it.kind.json),
                "number" to textJson(it.number),
                "fullName" to textJson(it.fullName),
                "issueDate" to textJson(it.issueDate),
                "expiryDate" to textJson(it.expiryDate),
                "issuer" to textJson(it.issuer),
            )
        },
        read = {
            DocumentFields(
                it.documentKind("kind"),
                it.text("number"),
                it.text("fullName"),
                it.text("issueDate"),
                it.text("expiryDate"),
                it.text("issuer"),
            )
        },
    )

    private val SPECS: Map<String, FieldsSpec<*>> =
        mapOf("login" to LOGIN, "contact" to CONTACT, "card" to CARD, "note" to NOTE, "document" to DOCUMENT)

    private fun parseFields(type: String, raw: JsonElement?): EntryFields {
        val spec = SPECS[type] ?: fail()
        if (raw !is JsonObject) fail()
        val reader = FieldReader(raw)
        return spec.read(reader).also { reader.requireAllRead() }
    }

    private fun fieldsJson(fields: EntryFields): JsonObject = when (fields) {
        is LoginFields -> LOGIN.write(fields)
        is ContactFields -> CONTACT.write(fields)
        is CardFields -> CARD.write(fields)
        NoteFields -> NOTE.write(NoteFields)
        is DocumentFields -> DOCUMENT.write(fields)
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
    fun contentJson(content: EntryContent): JsonObject = jsonObject(
        "type" to textJson(content.fields.type),
        "name" to textJson(content.name),
        "note" to textJson(content.note),
        "fields" to fieldsJson(content.fields),
        "custom" to customJson(content.custom),
    )

    private fun customJson(custom: List<CustomField>) = JsonArray(
        custom.map { jsonObject("label" to textJson(it.label), "value" to textJson(it.value), "hidden" to JsonPrimitive(it.hidden)) },
    )

    private fun attachmentJson(a: Attachment) = jsonObject(
        "id" to textJson(a.id),
        "name" to textJson(a.name),
        "mime" to textJson(a.mime),
        "size" to JsonPrimitive(a.size),
        "chunks" to JsonPrimitive(a.chunks),
        "sha256" to textJson(a.sha256),
        "key" to textJson(a.key),
    )

    private fun jsonObject(vararg pairs: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*pairs))

    /** Exactly `{hlc}`. */
    fun parseTombstone(value: JsonElement): TombstoneData {
        if (value !is JsonObject || value.keys != setOf("hlc")) throw IllegalArgumentException(INVALID_TOMBSTONE)
        return TombstoneData(strictHlc(value["hlc"], INVALID_TOMBSTONE))
    }
}
