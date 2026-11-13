package io.github.sheking94.passholder.core.files

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals

/** Runs host vector steps against any [FileStore] (memory now, disk in a later task). */
internal object FileHostSteps {
    /** The request of a step with its `expand` rule applied. */
    fun requestOf(step: JsonElement): JsonElement {
        val request = step.jsonObject.getValue("request")
        val expand = step.jsonObject["expand"]?.jsonObject ?: return request
        val field = expand.str("field")
        val repeat = expand.str("repeat")
        val count = expand.int("count").toInt()
        val value: JsonElement = if (field == "ids") {
            JsonArray(List(count) { JsonPrimitive(repeat) })
        } else {
            JsonPrimitive(repeat.repeat(count))
        }
        return JsonObject(request.jsonObject + (field to value))
    }

    fun run(store: FileStore, epoch: String, now: Long, steps: JsonArray) {
        for (step in steps) {
            val reply = FileHost.process(store, epoch, requestOf(step), now)
            val what = step.str("description")
            assertEquals(step.int("status").toInt(), reply.status, what)
            assertEquals(step.jsonObject.getValue("body"), reply.body, what)
        }
    }
}
