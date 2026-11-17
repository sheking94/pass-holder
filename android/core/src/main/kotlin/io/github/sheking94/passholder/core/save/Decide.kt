package io.github.sheking94.passholder.core.save

import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.pageScheme
import io.github.sheking94.passholder.core.p2p.CustomField
import io.github.sheking94.passholder.core.p2p.EntryContent
import io.github.sheking94.passholder.core.p2p.LoginFields

/** Port of core/src/save/decide.ts. */
data class SavedLogin(val id: String, val username: String, val password: String)

sealed interface SaveDecision {
    data object None : SaveDecision
    data object Create : SaveDecision
    data class Update(val id: String) : SaveDecision
}

private fun normalize(username: String) = username.trim().lowercase()

/**
 * Whether to save a submitted login (spec 3.2). [logins] are the exact-host matches in `matchLogins` order: only they
 * can be updated (review V3-S2). [related] (subdomain matches) only stop the question when the same login and
 * password are already saved there.
 */
fun decideSave(username: String, password: String, logins: List<SavedLogin>, related: List<SavedLogin> = emptyList()): SaveDecision {
    if (password.isEmpty()) return SaveDecision.None
    val same = logins.filter { normalize(it.username) == normalize(username) }
    if ((same + related.filter { normalize(it.username) == normalize(username) }).any { it.password == password }) {
        return SaveDecision.None
    }
    val first = same.firstOrNull() ?: return SaveDecision.Create
    return SaveDecision.Update(first.id)
}

/** What a submitted login is saved against: a site or an app. */
sealed interface SaveTarget {
    data class Web(val url: String) : SaveTarget
    data class App(val packageName: String) : SaveTarget
}

fun saveTargetFor(request: AppRequest): SaveTarget? {
    val domain = request.webDomain
    if (request.browserVerified && !domain.isNullOrEmpty()) {
        val url = saveUrl("${pageScheme(request)}://$domain") ?: return null
        return SaveTarget.Web(url)
    }
    return if (request.packageName.isEmpty()) null else SaveTarget.App(request.packageName)
}

/** New login for [target] (spec 3.3); [appLabel] names an app login. */
fun newLogin(target: SaveTarget, appLabel: String, username: String, password: String): EntryContent {
    val (name, urls, apps) = when (target) {
        is SaveTarget.Web -> Triple(saveName(target.url), listOf(target.url), emptyList<String>())
        is SaveTarget.App -> Triple(appLabel, emptyList<String>(), listOf(target.packageName))
    }
    return EntryContent(name, "", LoginFields(username, password, urls = urls, androidApps = apps), emptyList())
}

/** Label of the hidden custom field that keeps the password a save prompt replaced (review V3-S1). */
const val PREVIOUS_PASSWORD_LABEL = "Poprzednie hasło"

/**
 * Copy of the login with the new password; the old one goes to the hidden custom field „Poprzednie hasło”
 * (only the latest: an earlier such field is replaced), so a wrong save loses nothing.
 */
fun withPassword(content: EntryContent, password: String): EntryContent {
    val fields = content.fields as LoginFields
    val old = fields.password
    val custom = if (old.isEmpty() || old == password) {
        content.custom
    } else {
        content.custom.filter { it.label != PREVIOUS_PASSWORD_LABEL } + CustomField(PREVIOUS_PASSWORD_LABEL, old, true)
    }
    return content.copy(fields = fields.copy(password = password), custom = custom)
}
