package io.github.sheking94.passholder.app.autofill

import android.os.Build
import android.os.Bundle
import android.view.autofill.AutofillId
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.AppRequest
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

/** Null when the user turned the prompt off, the screen has no password field. */
fun saveSpecFor(app: PassHolderApp, request: ParsedRequest): SaveSpec? {
    if (!app.settings.askToSave) return null
    // Any screen with a password field, whatever group the request plans as; all nodes, not the plan's.
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

// Bundle.getParcelable(String, Class) exists only from API 33.
private fun Bundle.autofillId(key: String): AutofillId? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getParcelable(key, AutofillId::class.java)
    else @Suppress("DEPRECATION") getParcelable(key)

fun Bundle.saveSpecIds(): SavedIds? {
    val password = autofillId(KEY_PASSWORD) ?: return null
    val pkg = getString(KEY_PACKAGE) ?: return null
    return SavedIds(
        password,
        autofillId(KEY_USERNAME),
        AppRequest(pkg, getString(KEY_WEB_DOMAIN), getString(KEY_WEB_SCHEME)),
    )
}
