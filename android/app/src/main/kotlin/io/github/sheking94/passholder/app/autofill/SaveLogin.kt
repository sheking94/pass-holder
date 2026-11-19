package io.github.sheking94.passholder.app.autofill

import android.app.assist.AssistStructure
import android.content.pm.PackageManager
import android.service.autofill.SaveRequest
import android.view.autofill.AutofillId
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.AppRequest

/** A login the user submitted, read from the save request. */
data class SaveData(val app: AppRequest, val username: String, val password: String) {
    // Never print the password (logs, crash reports).
    override fun toString() = "SaveData(app=$app)"
}

enum class SaveOutcome { SAVED, UPDATED, NOTHING, LOCKED }

/**
 * Saves a submitted login as it was typed, without the review screen (Android 8.0-8.1, spec 5.2, 5.4). A locked
 * vault, also one whose deadline passed, saves nothing and reports [SaveOutcome.LOCKED].
 */
fun saveLogin(app: PassHolderApp, data: SaveData, appLabel: (String) -> String): SaveOutcome {
    val store = app.phoneStore
    app.leaveLock.lockIfExpired()
    if (!store.isUnlocked) return SaveOutcome.LOCKED
    // A blank name: a new login gets the default one.
    return saveSubmitted(app, data, appLabel(data.app.packageName), SaveDraft("", data.username, data.password))
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

/**
 * Null when the request carries no password (or no saved ids); a missing username becomes "". The app is checked
 * by its certificate here (V3-S3), so the review and the save trust only what the phone verified.
 */
fun readSaveData(app: PassHolderApp, request: SaveRequest): SaveData? {
    val ids = request.clientState?.saveSpecIds() ?: return null
    val password = request.valueOf(ids.password) ?: return null
    val username = ids.username?.let { request.valueOf(it) }.orEmpty()
    return SaveData(app.appTrust.verify(ids.app), username, password)
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
