package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Credentials

/** The login view of an entry, for tests; any other type is an [IllegalStateException]. */
val PhoneEntry.credentials: Credentials
    get() {
        val login = content.fields as? LoginFields ?: error("Entry $id is not a login")
        return Credentials(content.name, login.username, login.password)
    }
