package io.github.sheking94.passholder.core.save

import io.github.sheking94.passholder.core.autofill.AutofillNode
import io.github.sheking94.passholder.core.autofill.FieldKind
import io.github.sheking94.passholder.core.autofill.classifyField

data class SaveFields<Id>(val password: Id, val username: Id?)

/**
 * Password = first new-password field, else first password field; username = first username field,
 * else the last e-mail field before the password. Null when there is no password field.
 */
fun <Id> saveFields(nodes: List<AutofillNode<Id>>): SaveFields<Id>? {
    val classified = nodes.mapIndexedNotNull { i, n -> classifyField(n.field)?.let { Triple(i, n.id, it) } }
    val password = classified.firstOrNull { it.third == FieldKind.NEW_PASSWORD }
        ?: classified.firstOrNull { it.third == FieldKind.PASSWORD }
        ?: return null
    val username = classified.firstOrNull { it.third == FieldKind.USERNAME }
        ?: classified.lastOrNull { it.third == FieldKind.EMAIL && it.first < password.first }
    return SaveFields(password.second, username?.second)
}
