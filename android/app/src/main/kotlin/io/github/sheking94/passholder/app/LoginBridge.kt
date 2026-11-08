package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.PhoneEntry

/** The login view of an entry, null for other types. Temporary: the screens for every type replace it. */
internal fun PhoneEntry.loginCredentials(): Credentials? {
    val login = content.fields as? LoginFields ?: return null
    return Credentials(content.name, login.username, login.password)
}
