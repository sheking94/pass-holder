package io.github.sheking94.passholder.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class MasterPasswordRulesTest {
    @Test
    fun `too short`() = assertEquals("Hasło główne musi mieć co najmniej 12 znaków", MasterPasswordRules.problem("Krótkie1!"))

    @Test
    fun `counts characters, not UTF-16 units`() {
        assertNotNull(MasterPasswordRules.problem("😀😀😀😀😀😀"))
    }

    @Test
    fun `refuses the obvious long ones`() {
        listOf(
            "aaaaaaaaaaaa", "aaaaaabbbbbb", "abcabcabcabc", "2026202620262026",
            "123456789012", "987654321098", "abcdefghijkl", "qwertyuiopas", "QWERTYUIOPAS", "lkjhgfdsapoi",
            "password2026", "Haslo1234567", "hasło2026!!!", "qwerty123456", "iloveyou1234",
        ).forEach { assertNotNull(it, MasterPasswordRules.problem(it)) }
    }

    @Test
    fun `accepts real passphrases`() {
        listOf(
            "Zażółć gęślą jaźń 2026", "correct horse battery staple", "mój kot ma 3 łapy", "Tr0mb0n-Kasza-Lipa",
            "password do banku zielony", "abcd!x7Qm#2pZ",
        ).forEach { assertNull(it, MasterPasswordRules.problem(it)) }
    }
}
