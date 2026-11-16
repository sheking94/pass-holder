package io.github.sheking94.passholder.core.save

import io.github.sheking94.passholder.core.autofill.AutofillNode
import io.github.sheking94.passholder.core.autofill.FieldDescriptor
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class SaveFieldsTest {
    private fun node(id: Int, hint: String, type: String = "") =
        AutofillNode(id, FieldDescriptor(autocomplete = listOf(hint), type = type), false)

    @Test
    fun usernameAndPassword() {
        val r = saveFields(listOf(node(1, "username"), node(2, "current-password", "password")))
        assertEquals(SaveFields(2, 1), r)
    }

    @Test
    fun emailActsAsLogin() {
        assertEquals(SaveFields(2, 1), saveFields(listOf(node(1, "email"), node(2, "current-password"))))
    }

    @Test
    fun firstNewPasswordWins() {
        val r = saveFields(listOf(node(1, "current-password"), node(2, "new-password"), node(3, "new-password")))
        assertEquals(2, r?.password)
    }

    @Test
    fun noPasswordGivesNull() {
        assertNull(saveFields(listOf(node(1, "username"))))
    }

    @Test
    fun emailAfterPasswordIsNotLogin() {
        assertNull(saveFields(listOf(node(1, "current-password"), node(2, "email")))?.username)
    }
}
