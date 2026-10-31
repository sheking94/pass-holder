package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable

/** Character groups from docs/SPEC.md §8. */
enum class CharacterGroup(val chars: String) {
    LOWERCASE("abcdefghijklmnopqrstuvwxyz"),
    UPPERCASE("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    DIGITS("0123456789"),
    SYMBOLS("!@#\$%^&*()-_=+[]{};:,.<>?/~"),
}

@Serializable
data class GeneratorOptions(val length: Int = 20, val groups: Set<CharacterGroup> = CharacterGroup.entries.toSet())

/** Password generator, same rules as core/src/generator.ts. */
object PasswordGenerator {
    const val MIN_LENGTH = 4
    const val MAX_LENGTH = 128

    /** Password with at least one character from every chosen group. */
    fun generate(options: GeneratorOptions = GeneratorOptions()): String {
        require(options.groups.isNotEmpty()) { "Wybierz co najmniej jedną grupę znaków" }
        require(options.length in MIN_LENGTH..MAX_LENGTH) { "Długość musi być od $MIN_LENGTH do $MAX_LENGTH" }
        val groups = CharacterGroup.entries.filter { it in options.groups }
        fun pick(chars: String) = chars[Encoding.randomIndex(chars.length)]
        val all = groups.joinToString("") { it.chars }
        val chars = groups.map { pick(it.chars) }.toMutableList()
        while (chars.size < options.length) chars += pick(all)
        // Fisher-Yates, so the guaranteed characters are not always at the start.
        for (i in chars.indices.reversed()) {
            if (i == 0) break
            val j = Encoding.randomIndex(i + 1)
            chars[i] = chars[j].also { chars[j] = chars[i] }
        }
        return chars.joinToString("")
    }
}
