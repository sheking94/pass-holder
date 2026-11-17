package io.github.sheking94.passholder.core

import java.time.DateTimeException
import java.time.LocalDate

/** Formats of entry fields, shared by the forms, autofill and import/export (core/src/field-formats.ts). */
object FieldFormats {
    // [0-9], not \d: on Android (ICU) \d also matches non-ASCII digits.

    /** Card expiry "MM/RR"; groups: month, two-digit year. */
    val CARD_EXPIRY = Regex("^(0[1-9]|1[0-2])/([0-9]{2})$")

    private val DATE = Regex("^([0-9]{4})-([0-9]{2})-([0-9]{2})$")

    /** True for a real calendar date written as RRRR-MM-DD. */
    fun isCalendarDate(s: String): Boolean {
        val m = DATE.matchEntire(s) ?: return false
        return try {
            LocalDate.of(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
            true
        } catch (_: DateTimeException) {
            false
        }
    }
}
