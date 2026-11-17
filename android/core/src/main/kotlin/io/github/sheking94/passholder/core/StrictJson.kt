package io.github.sheking94.passholder.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Helpers for strict JSON parsing: a value of the wrong JSON type counts as missing, never converted.
 * Also the string escaping that makes Kotlin's JSON text identical to JavaScript's. TS twin: core/src/strict-json.ts.
 */
object StrictJson {
    /** The text of a JSON string; null for a missing value or any other type (number, boolean, null, object, array). */
    fun string(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** A JSON true or false; null for a missing value or any other type (also the strings "true" and "false"). */
    fun boolean(value: JsonElement?): Boolean? = (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    /** JS JSON.stringify string escaping: quote, backslash, C0 controls (short forms, else lowercase \u00xx), lone surrogates. */
    fun appendQuoted(sb: StringBuilder, s: String) {
        sb.append('"')
        for ((i, ch) in s.withIndex()) {
            when {
                ch == '"' -> sb.append("\\\"")

                ch == '\\' -> sb.append("\\\\")

                ch == '\b' -> sb.append("\\b")

                ch == '\u000C' -> sb.append("\\f")

                ch == '\n' -> sb.append("\\n")

                ch == '\r' -> sb.append("\\r")

                ch == '\t' -> sb.append("\\t")

                ch < ' ' -> sb.append("\\u").append(String.format("%04x", ch.code))

                ch.isHighSurrogate() && !(i + 1 < s.length && s[i + 1].isLowSurrogate()) ->
                    sb.append("\\u").append(String.format("%04x", ch.code))

                ch.isLowSurrogate() && !(i > 0 && s[i - 1].isHighSurrogate()) ->
                    sb.append("\\u").append(String.format("%04x", ch.code))

                else -> sb.append(ch)
            }
        }
        sb.append('"')
    }
}
