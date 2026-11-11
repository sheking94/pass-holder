package io.github.sheking94.passholder.core.autofill

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive

internal fun readAutofillCases(name: String): List<JsonObject> {
    val text = File(System.getProperty("passholder.repoRoot"), "core/test-vectors/autofill/$name").readText()
    return ((Json.parseToJsonElement(text) as JsonObject)["cases"] as JsonArray).map { it as JsonObject }
}

internal fun JsonObject.str(key: String): String = this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content ?: ""

internal fun JsonElement?.toFieldDescriptor(): FieldDescriptor {
    val o = this as JsonObject
    return FieldDescriptor(
        autocomplete = (o["autocomplete"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList(),
        type = o.str("type"),
        name = o.str("name"),
        id = o.str("id"),
        label = o.str("label"),
        placeholder = o.str("placeholder"),
        maxLength = o["maxLength"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.int,
        options = (o["options"] as? JsonArray)?.map {
            val oo = it as JsonObject
            FieldOption(oo.str("value"), oo.str("text"))
        },
    )
}
