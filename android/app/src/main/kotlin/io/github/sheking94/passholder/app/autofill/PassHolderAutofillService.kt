package io.github.sheking94.passholder.app.autofill

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.util.Log
import android.view.autofill.AutofillId
import android.view.inputmethod.InlineSuggestionsRequest
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.DatasetSpec
import io.github.sheking94.passholder.core.autofill.FillRequestPlan
import io.github.sheking94.passholder.core.autofill.planDatasets
import io.github.sheking94.passholder.core.autofill.planRequest
import io.github.sheking94.passholder.core.p2p.LoginFields
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Suggestions and the save request for the unlocked vault (null when neither applies); also used by the unlock screen. */
fun buildFillResponse(app: PassHolderApp, request: ParsedRequest, inline: InlineSuggestionsRequest?): FillResponse? {
    val save = saveSpecFor(app, request)
    val plan = planRequest(request.nodes) ?: return save?.let(::saveOnlyResponse)
    return ResponseBuilder(app, inline).datasets(datasetsFor(app, request, plan), save)
}

/**
 * The answer to one fill request: nothing for PassHolder itself, a phone without a vault or a screen with neither fillable
 * nor password fields (a password-only screen gets just the save request); the unlock prompt for a locked vault ([auth] is only called then); otherwise the suggestions.
 */
internal fun respond(
    app: PassHolderApp,
    request: ParsedRequest,
    inline: InlineSuggestionsRequest?,
    auth: () -> IntentSender,
): FillResponse? {
    if (request.app.packageName == app.packageName) return null
    val store = app.phoneStore
    if (!store.hasVault) return null
    val save = saveSpecFor(app, request)
    // Nothing to fill (e.g. only a "new password" field): at most the save request, never the unlock prompt.
    val plan = planRequest(request.nodes) ?: return save?.let(::saveOnlyResponse)
    app.leaveLock.lockIfExpired()
    val builder = ResponseBuilder(app, inline)
    if (!store.isUnlocked) return builder.locked(plan.nodes.map { it.first.id }, auth(), save)
    return builder.datasets(datasetsFor(app, request, plan), save)
}

/** The datasets of the unlocked vault for [plan]. Entries are decrypted here, per request, and dropped with the response. */
private fun datasetsFor(app: PassHolderApp, request: ParsedRequest, plan: FillRequestPlan<AutofillId>): List<DatasetSpec<AutofillId>> {
    val entries = app.phoneStore.entries()
    val pkg = request.app.packageName
    // Trust on first use (V3-S3): the first fill for an app tied to a login remembers its certificate.
    if (entries.any { (it.content.fields as? LoginFields)?.androidApps?.contains(pkg) == true }) app.appTrust.rememberIfNew(pkg)
    return planDatasets(plan, app.appTrust.verify(request.app), entries)
}

/**
 * The intent behind "Odblokuj PassHolder". MUTABLE: the system adds EXTRA_ASSIST_STRUCTURE (and the inline
 * request) to it. UPDATE_CURRENT, not CANCEL_CURRENT: the identity is the same for every request, and
 * cancelling would make the suggestion of a response still on screen dead.
 */
internal fun unlockPendingIntent(context: Context): PendingIntent = PendingIntent.getActivity(
    context,
    0,
    Intent(context, AutofillUnlockActivity::class.java),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
)

/**
 * The intent behind the system's save question (Android 9+): opens the review screen. IMMUTABLE and without
 * data: the candidate is in [PassHolderApp.pendingSave], never in the intent. requestCode 1 keeps it apart from [unlockPendingIntent].
 */
internal fun savePendingIntent(context: Context): PendingIntent = PendingIntent.getActivity(
    context,
    1,
    Intent(context, AutofillSaveActivity::class.java),
    PendingIntent.FLAG_IMMUTABLE,
)

/** The system autofill service. Holds no entries or keys: each request reads the store anew. */
class PassHolderAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val cancelled = AtomicBoolean(false)
        cancellationSignal.setOnCancelListener { cancelled.set(true) }
        val app = application as PassHolderApp
        val structure = request.fillContexts.lastOrNull()?.structure
        val inline = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) request.inlineSuggestionsRequest else null
        thread(name = "PassHolder-autofill") {
            val response = try {
                structure?.let { respond(app, readRequest(it), inline, ::unlockSender) }
            } catch (e: Exception) {
                Log.w(PassHolderApp.TAG, "Autofill request failed", e)
                null
            }
            if (cancelled.get()) return@thread
            try {
                callback.onSuccess(response)
            } catch (e: Exception) {
                Log.w(PassHolderApp.TAG, "Autofill response rejected", e)
            }
        }
    }

    private fun unlockSender(): IntentSender = unlockPendingIntent(this).intentSender

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        val app = application as PassHolderApp
        thread(name = "PassHolder-autofill-save") {
            try {
                save(app, request, callback)
            } catch (e: Exception) {
                Log.w(PassHolderApp.TAG, "Saving the login failed", e)
                app.pendingSave.clear()
                try {
                    callback.onFailure(SAVE_FAILED)
                } catch (e2: Exception) {
                    Log.w(PassHolderApp.TAG, "Save failure rejected", e2)
                }
            }
        }
    }

    /**
     * Every save goes through the review screen (spec 5.4), unlocking first when locked; the candidate stays in
     * memory (not in the intent) for it. Android 8.0-8.1 cannot open a screen here: it saves as typed, or asks to
     * unlock first.
     */
    private fun save(app: PassHolderApp, request: SaveRequest, callback: SaveCallback) {
        val data = readSaveData(app, request)
        if (data != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            app.pendingSave.put(data)
            callback.onSuccess(savePendingIntent(this).intentSender)
            return
        }
        val outcome = data?.let { saveLogin(app, it) { pkg -> appLabelOf(packageManager, pkg) } } ?: SaveOutcome.NOTHING
        if (outcome == SaveOutcome.LOCKED) {
            callback.onFailure("Odblokuj PassHolder i spróbuj ponownie")
            return
        }
        saveToast(outcome)?.let(::showToast)
        callback.onSuccess()
    }
}
