package io.github.sheking94.passholder.app.autofill

import android.os.Bundle
import android.view.autofill.AutofillId
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.FillGroup
import io.github.sheking94.passholder.core.autofill.planRequest
import io.github.sheking94.passholder.core.save.SaveFields
import io.github.sheking94.passholder.core.save.saveFields

/** What a fill response asks the system to watch for a save: the login fields and who they belong to. */
class SaveSpec(val fields: SaveFields<AutofillId>, val app: AppRequest)

/** The ids and app that [SaveSpec.toClientState] stored, read back in `onSaveRequest`. */
data class SavedIds(val password: AutofillId, val username: AutofillId?, val app: AppRequest)

private const val KEY_PASSWORD = "save.password"
private const val KEY_USERNAME = "save.username"
private const val KEY_PACKAGE = "save.package"
private const val KEY_WEB_DOMAIN = "save.webDomain"
private const val KEY_WEB_SCHEME = "save.webScheme"

/** Null when the user turned the prompt off, the screen is not a login or has no password field. */
fun saveSpecFor(app: PassHolderApp, request: ParsedRequest): SaveSpec? {
    if (!app.settings.askToSave) return null
    if (planRequest(request.nodes)?.group != FillGroup.LOGIN) return null
    // All nodes, not the plan's: planRequest drops NEW_PASSWORD from the LOGIN group.
    val fields = saveFields(request.nodes) ?: return null
    return SaveSpec(fields, request.app)
}

fun SaveSpec.toClientState(): Bundle = Bundle().apply {
    putParcelable(KEY_PASSWORD, fields.password)
    fields.username?.let { putParcelable(KEY_USERNAME, it) }
    putString(KEY_PACKAGE, app.packageName)
    app.webDomain?.let { putString(KEY_WEB_DOMAIN, it) }
    app.webScheme?.let { putString(KEY_WEB_SCHEME, it) }
}

fun Bundle.saveSpecIds(): SavedIds? {
    val password = getParcelable(KEY_PASSWORD, AutofillId::class.java) ?: return null
    val pkg = getString(KEY_PACKAGE) ?: return null
    return SavedIds(
        password,
        getParcelable(KEY_USERNAME, AutofillId::class.java),
        AppRequest(pkg, getString(KEY_WEB_DOMAIN), getString(KEY_WEB_SCHEME)),
    )
}
