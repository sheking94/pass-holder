package io.github.sheking94.passholder.core.transfer

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CsvTest {
    @Test
    fun handlesQuotesCommasDoubledQuotesLineBreaksCrlfBomAndBlankLines() {
        val text = "﻿a,b,c\r\n\"x, y\",\"say \"\"hi\"\"\",\"line1\nline2\"\r\n\r\nlast,,\n"
        assertEquals(
            listOf(
                Csv.Row(1, listOf("a", "b", "c")),
                Csv.Row(2, listOf("x, y", "say \"hi\"", "line1\nline2")),
                Csv.Row(5, listOf("last", "", "")),
            ),
            Csv.parse(text),
        )
    }

    @Test
    fun readsLastRowWithoutLineBreak() {
        assertEquals(listOf(Csv.Row(1, listOf("a", "b")), Csv.Row(2, listOf("1", "2"))), Csv.parse("a,b\n1,2"))
    }

    @Test
    fun rejectsUnclosedQuote() {
        val e = assertThrows(IllegalArgumentException::class.java) { Csv.parse("a\n\"oops") }
        assertTrue(e.message!!.contains("niezamknięty cudzysłów"))
        assertTrue(e.message!!.contains("wiersz 2"))
    }

    @Test
    fun writeQuotesSpecialFieldsAndEndsRowsWithCrlf() {
        val rows = listOf(listOf("a", "b,c", "q\"q", " s "), listOf("x", "", "l\nl", "z"))
        val csv = Csv.write(rows)
        assertEquals("a,\"b,c\",\"q\"\"q\",\" s \"\r\nx,,\"l\nl\",z\r\n", csv)
        assertEquals(rows, Csv.parse(csv).map { it.fields })
    }
}
