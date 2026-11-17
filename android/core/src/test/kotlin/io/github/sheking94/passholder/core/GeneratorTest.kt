package io.github.sheking94.passholder.core

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.assertCode
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class GeneratorTest {
    @Test
    fun `default is 20 characters with every group`() {
        repeat(200) {
            val password = PasswordGenerator.generate()
            assertEquals(20, password.length)
            for (group in CharacterGroup.entries) assertTrue(password.any { it in group.chars }, "$group in $password")
        }
    }

    @Test
    fun `uses only the chosen groups and has one of each even at minimum length`() {
        val options = GeneratorOptions(4, setOf(CharacterGroup.DIGITS, CharacterGroup.SYMBOLS))
        repeat(200) {
            val password = PasswordGenerator.generate(options)
            assertEquals(4, password.length)
            assertTrue(password.all { it in CharacterGroup.DIGITS.chars || it in CharacterGroup.SYMBOLS.chars })
            assertTrue(password.any { it in CharacterGroup.DIGITS.chars })
            assertTrue(password.any { it in CharacterGroup.SYMBOLS.chars })
        }
    }

    @Test
    fun `rejects bad options`() {
        assertCode(ErrorCode.GENERATOR_NO_GROUPS) { PasswordGenerator.generate(GeneratorOptions(20, emptySet())) }
        assertCode(ErrorCode.GENERATOR_BAD_LENGTH) { PasswordGenerator.generate(GeneratorOptions(3)) }
        assertCode(ErrorCode.GENERATOR_BAD_LENGTH) { PasswordGenerator.generate(GeneratorOptions(129)) }
    }

    @Test
    fun `characters are roughly uniform`() {
        val counts = IntArray(10)
        repeat(20_000) { PasswordGenerator.generate(GeneratorOptions(4, setOf(CharacterGroup.DIGITS))).forEach { counts[it - '0']++ } }
        // 80 000 digits, 8 000 expected each; a biased generator would drift far beyond ±10 %.
        assertTrue(counts.all { it in 7200..8800 }, counts.joinToString())
    }
}
