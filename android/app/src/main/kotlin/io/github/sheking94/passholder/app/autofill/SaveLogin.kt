package io.github.sheking94.passholder.app.autofill

import android.app.assist.AssistStructure
import android.content.pm.PackageManager
import android.service.autofill.SaveRequest
import android.view.autofill.AutofillId
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.AppCandidate
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.matchApp
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.save.SaveDecision
import io.github.sheking94.passholder.core.save.SaveTarget
import io.github.sheking94.passholder.core.save.SavedLogin
import io.github.sheking94.passholder.core.save.decideSave
import io.github.sheking94.passholder.core.save.newLogin
import io.github.sheking94.passholder.core.save.saveTargetFor
import io.github.sheking94.passholder.core.save.withPassword
import java.util.UUID

/** A login the user submitted, read from the save request. */
data class SaveData(val app: AppRequest, val username: String, val password: String)

enum class SaveOutcome { SAVED, UPDATED, NOTHING, LOCKED }

/**
 * Saves a submitted login (spec 3.2, 3.3). A locked vault, also one whose deadline passed, saves nothing
 * and reports [SaveOutcome.LOCKED].
 */
fun saveLogin(app: PassHolderApp, data: SaveData, appLabel: (String) -> String): SaveOutcome {
    val store = app.phoneStore
    // D1: the 60 s timer may not have run (deep sleep, a frozen app); the deadline still holds.
    if (app.leaveLock.expired()) store.lock()
    if (!store.isUnlocked) return SaveOutcome.LOCKED
    val target = saveTargetFor(data.app) ?: return SaveOutcome.NOTHING
    val logins = matchApp(data.app, store.entries().filter { it.content.fields is LoginFields }) {
        val f = it.content.fields as LoginFields
        AppCandidate(it.content.name, f.urls, f.androidApps)
    }
    val saved = logins.map {
        val f = it.content.fields as LoginFields
        SavedLogin(it.id, f.username, f.password)
    }
    return when (val decision = decideSave(data.username, data.password, saved)) {
        SaveDecision.None -> SaveOutcome.NOTHING
        SaveDecision.Create -> {
            val label = (target as? SaveTarget.App)?.let { appLabel(it.packageName) }.orEmpty()
            store.upsertContent(UUID.randomUUID().toString(), newLogin(target, label, data.username, data.password))
            SaveOutcome.SAVED
        }
        is SaveDecision.Update -> {
            val entry = logins.first { it.id == decision.id }
            store.upsertContent(entry.id, withPassword(entry.content, data.password))
            SaveOutcome.UPDATED
        }
    }
}

/** Text typed into the node with [id], searched through the whole structure; null when absent. */
private fun AssistStructure.textOf(id: AutofillId): String? {
    fun walk(node: AssistStructure.ViewNode): String? {
        if (node.autofillId == id) return node.autofillValue?.takeIf { it.isText }?.textValue?.toString()
        for (i in 0 until node.childCount) walk(node.getChildAt(i))?.let { return it }
        return null
    }
    for (i in 0 until windowNodeCount) walk(getWindowNodeAt(i).rootViewNode)?.let { return it }
    return null
}

/** The first non-empty value of [id] over the contexts, latest first (a field may be cleared on submit). */
private fun SaveRequest.valueOf(id: AutofillId): String? =
    fillContexts.asReversed().firstNotNullOfOrNull { it.structure.textOf(id)?.takeIf(String::isNotEmpty) }

/** Null when the request carries no password (or no saved ids); a missing username becomes "". */
fun readSaveData(request: SaveRequest): SaveData? {
    val ids = request.clientState?.saveSpecIds() ?: return null
    val password = request.valueOf(ids.password) ?: return null
    val username = ids.username?.let { request.valueOf(it) }.orEmpty()
    return SaveData(ids.app, username, password)
}

fun saveToast(outcome: SaveOutcome): String? = when (outcome) {
    SaveOutcome.SAVED -> "Zapisano w PassHolder"
    SaveOutcome.UPDATED -> "Zaktualizowano hasło w PassHolder"
    SaveOutcome.NOTHING, SaveOutcome.LOCKED -> null
}

/** Label of an installed app, its package name when unreadable. */
fun appLabelOf(pm: PackageManager, packageName: String): String = try {
    pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
} catch (e: Exception) {
    packageName
}
