package io.github.sheking94.passholder.core.transfer

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Text form of a JSON tree identical to JavaScript JSON.stringify(v, null, 2) (no trailing newline). */
object JsonText {
    fun stringify(value: JsonElement): String = StringBuilder().also { write(it, value, 0) }.toString()

    private fun indent(sb: StringBuilder, depth: Int) {
        sb.append('\n')
        repeat(depth) { sb.append("  ") }
    }

    private fun write(sb: StringBuilder, v: JsonElement, depth: Int) {
        when (v) {
            is JsonNull -> sb.append("null")
            is JsonPrimitive -> if (v.isString) str(sb, v.content) else sb.append(v.content)
            is JsonArray -> {
                if (v.isEmpty()) {
                    sb.append("[]")
                    return
                }
                sb.append('[')
                v.forEachIndexed { i, x ->
                    if (i > 0) sb.append(',')
                    indent(sb, depth + 1)
                    write(sb, x, depth + 1)
                }
                indent(sb, depth)
                sb.append(']')
            }
            is JsonObject -> {
                if (v.isEmpty()) {
                    sb.append("{}")
                    return
                }
                sb.append('{')
                var first = true
                for ((k, x) in v) {
                    if (!first) sb.append(',')
                    first = false
                    indent(sb, depth + 1)
                    str(sb, k)
                    sb.append(": ")
                    write(sb, x, depth + 1)
                }
                indent(sb, depth)
                sb.append('}')
            }
        }
    }

    /** JS string escaping: quote, backslash, C0 controls (short forms, else lowercase \u00xx), lone surrogates as \uxxxx. */
    private fun str(sb: StringBuilder, s: String) {
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
