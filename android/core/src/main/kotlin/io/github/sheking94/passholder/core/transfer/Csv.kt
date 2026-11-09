package io.github.sheking94.passholder.core.transfer

/** CSV (RFC 4180) reading and writing shared by the importers and exporters. Port of core/src/transfer/csv.ts. */
object Csv {
    data class Row(val line: Int, val fields: List<String>)

    /**
     * Splits CSV text into rows of fields. Handles quoted fields with commas, doubled quotes and
     * line breaks inside, CRLF or LF line ends and a UTF-8 BOM. Blank lines are dropped.
     */
    fun parse(text: String): List<Row> {
        val rows = mutableListOf<Row>()
        var fields = mutableListOf<String>()
        val field = StringBuilder()
        var quoted = false
        var line = 1
        var rowStartLine = 1
        val input = if (text.startsWith("﻿")) text.substring(1) else text

        fun endRow() {
            fields.add(field.toString())
            if (fields.size > 1 || fields[0] != "") rows.add(Row(rowStartLine, fields))
            fields = mutableListOf()
            field.setLength(0)
            rowStartLine = line
        }

        var i = 0
        while (i < input.length) {
            val c = input[i]
            if (quoted) {
                if (c == '"' && input.getOrNull(i + 1) == '"') {
                    field.append('"')
                    i++
                } else if (c == '"') {
                    quoted = false
                } else {
                    if (c == '\n') line++
                    field.append(c)
                }
            } else if (c == '"' && field.isEmpty()) {
                quoted = true
            } else if (c == ',') {
                fields.add(field.toString())
                field.setLength(0)
            } else if (c == '\n' || c == '\r') {
                if (c == '\r' && input.getOrNull(i + 1) == '\n') i++
                line++
                endRow()
            } else {
                field.append(c)
            }
            i++
        }
        if (quoted) throw IllegalArgumentException("Plik CSV jest uszkodzony: niezamknięty cudzysłów (wiersz $rowStartLine)")
        if (field.isNotEmpty() || fields.isNotEmpty()) endRow()
        return rows
    }

    private fun csvField(value: String): String =
        if (value.any { it == '"' || it == ',' || it == '\r' || it == '\n' } || value != value.jsTrim()) {
            "\"" + value.replace("\"", "\"\"") + "\""
        } else {
            value
        }

    /** Rows separated by CRLF, with a trailing CRLF. */
    fun write(rows: List<List<String>>): String = rows.joinToString("") { row -> row.joinToString(",", transform = ::csvField) + "\r\n" }
}

/** JavaScript String.prototype.trim whitespace (WhiteSpace + LineTerminator), not Kotlin's Char.isWhitespace. */
internal fun String.jsTrim(): String = trim(JS_WS)

private val JS_WS: (Char) -> Boolean = { it in "\t\n\u000B\u000C\r       　﻿" || it in ' '..' ' }
