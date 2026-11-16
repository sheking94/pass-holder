package io.github.sheking94.passholder.core

import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields

/** Name, username and password of a login, as tests write and read them. */
data class Credentials(val name: String, val username: String, val password: String)

/** A new login with only name, username and password set (the rest empty), as upsertContent takes it. */
fun login(name: String, username: String, password: String): EntryContentV3 =
    EntryContentV3(name, "", LoginFields(username, password), emptyList())
