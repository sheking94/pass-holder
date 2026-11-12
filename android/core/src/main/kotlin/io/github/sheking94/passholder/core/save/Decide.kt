package io.github.sheking94.passholder.core.save

import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.TRUSTED_BROWSERS
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields

/** Port of core/src/save/decide.ts. */
data class SavedLogin(val id: String, val username: String, val password: String)

sealed interface SaveDecision {
    data object None : SaveDecision
    data object Create : SaveDecision
    data class Update(val id: String) : SaveDecision
}

private fun normalize(username: String) = username.trim().lowercase()

/** Whether to save a submitted login (spec 3.2); [logins] are in `matchLogins` order. */
fun decideSave(username: String, password: String, logins: List<SavedLogin>): SaveDecision {
    if (password.isEmpty()) return SaveDecision.None
    val same = logins.filter { normalize(it.username) == normalize(username) }
    val first = same.firstOrNull() ?: return SaveDecision.Create
    if (same.any { it.password == password }) return SaveDecision.None
    return SaveDecision.Update(first.id)
}

/** What a submitted login is saved against: a site or an app. */
sealed interface SaveTarget {
    data class Web(val url: String) : SaveTarget
    data class App(val packageName: String) : SaveTarget
}

fun saveTargetFor(request: AppRequest): SaveTarget? {
    val domain = request.webDomain
    if (request.packageName in TRUSTED_BROWSERS && !domain.isNullOrEmpty()) {
        val url = saveUrl("${request.webScheme ?: "https"}://$domain") ?: return null
        return SaveTarget.Web(url)
    }
    return if (request.packageName.isEmpty()) null else SaveTarget.App(request.packageName)
}

/** New login for [target] (spec 3.3); [appLabel] names an app login. */
fun newLogin(target: SaveTarget, appLabel: String, username: String, password: String): EntryContentV3 {
    val (name, urls, apps) = when (target) {
        is SaveTarget.Web -> Triple(saveName(target.url), listOf(target.url), emptyList<String>())
        is SaveTarget.App -> Triple(appLabel, emptyList<String>(), listOf(target.packageName))
    }
    return EntryContentV3(name, "", LoginFields(username, password, urls = urls, androidApps = apps), emptyList())
}

/** Copy of the login with only the password changed. */
fun withPassword(content: EntryContentV3, password: String): EntryContentV3 {
    val fields = content.fields as LoginFields
    return content.copy(fields = fields.copy(password = password))
}
