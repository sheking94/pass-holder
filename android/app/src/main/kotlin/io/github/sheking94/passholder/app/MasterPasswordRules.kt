package io.github.sheking94.passholder.app

import java.util.Locale

/**
 * Rules for a new master password (security review I4): at least [MIN_LENGTH] characters, and none of the
 * patterns a guesser tries first. Not a strength meter: it only stops passwords that are long but obviously weak.
 */
object MasterPasswordRules {
    const val MIN_LENGTH = 12

    /** Fragments of the most common passwords (Polish and English); see [problem]. */
    private val COMMON_FRAGMENTS = listOf(
        "password", "passw0rd", "hasło", "haslo", "qwerty", "qwertz", "asdfgh", "zxcvbn", "admin",
        "iloveyou", "kocham", "welcome", "letmein", "monkey", "dragon", "abc", "123",
    )

    /** Why [password] is refused, as a message for the user, or null when it passes. */
    fun problem(password: String): String? {
        val chars = password.codePoints().toArray()
        if (chars.size < MIN_LENGTH) return "Hasło główne musi mieć co najmniej $MIN_LENGTH znaków"
        if (chars.distinct().size < 5) return "Hasło główne ma za mało różnych znaków"
        if (repeatsBlock(chars)) return "Hasło główne powtarza ten sam fragment"
        val lower = password.lowercase(Locale.ROOT)
        if (isRun(lower.codePoints().toArray())) return "Hasło główne to prosty ciąg znaków"
        if (onlyCommonFragments(lower)) return "Hasło główne składa się z popularnych fragmentów haseł"
        return null
    }

    /** "abcabcabcabc", "2026202620262026": the whole password is one short block repeated. */
    private fun repeatsBlock(chars: IntArray): Boolean = (1..chars.size / 2).any { block ->
        chars.size % block == 0 && chars.indices.all { chars[it] == chars[it % block] }
    }

    /** "abcdefghijkl", "987654321098" (digits wrap around), "qwertyuiopas" (a keyboard row). */
    private fun isRun(chars: IntArray): Boolean {
        val text = String(chars, 0, chars.size)
        val digitsUp = "1234567890".repeat(4)
        val digitsDown = digitsUp.reversed()
        val rows = listOf("qwertyuiopasdfghjklzxcvbnm", "qwertzuiopasdfghjklyxcvbnm", "abcdefghijklmnopqrstuvwxyz")
        val runs = listOf(digitsUp, digitsDown) + rows + rows.map { it.reversed() }
        return runs.any { it.contains(text) }
    }

    /** "password2026", "Haslo1234567": nothing left but digits and symbols once the common fragments are cut out. */
    private fun onlyCommonFragments(lower: String): Boolean {
        var rest = lower
        COMMON_FRAGMENTS.forEach { rest = rest.replace(it, "") }
        return rest.length < lower.length && rest.none { it.isLetter() } && rest.toSet().size < 5
    }
}
