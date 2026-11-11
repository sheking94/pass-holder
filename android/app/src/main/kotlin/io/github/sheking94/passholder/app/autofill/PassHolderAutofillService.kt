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
import android.view.inputmethod.InlineSuggestionsRequest
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.planDatasets
import io.github.sheking94.passholder.core.autofill.planRequest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Suggestions for the unlocked vault (null when no entry matches); also used by the unlock screen. */
fun buildFillResponse(app: PassHolderApp, request: ParsedRequest, inline: InlineSuggestionsRequest?): FillResponse? {
    val plan = planRequest(request.nodes) ?: return null
    // Entries are decrypted here, per request, and dropped with the response.
    val specs = planDatasets(plan, request.app, app.phoneStore.entries())
    return ResponseBuilder.datasets(app, specs, inline)
}

/**
 * The answer to one fill request: nothing for PassHolder itself, a screen without fillable fields or a phone
 * without a vault; the unlock prompt for a locked vault ([auth] is only called then); otherwise the suggestions.
 */
internal fun respond(
    app: PassHolderApp,
    request: ParsedRequest,
    inline: InlineSuggestionsRequest?,
    auth: () -> IntentSender,
): FillResponse? {
    if (request.app.packageName == app.packageName) return null
    val plan = planRequest(request.nodes) ?: return null
    val store = app.phoneStore
    if (!store.hasVault) return null
    // D1: the 60 s timer may not have run (deep sleep, a frozen app); the deadline still holds.
    if (app.leaveLock.expired()) store.lock()
    if (!store.isUnlocked) return ResponseBuilder.locked(app, plan.nodes.map { it.first.id }, auth(), inline)
    return buildFillResponse(app, request, inline)
}

/**
 * The intent behind "Odblokuj PassHolder". MUTABLE: the system adds EXTRA_ASSIST_STRUCTURE (and the inline
 * request) to it. UPDATE_CURRENT, not CANCEL_CURRENT: the identity is the same for every request, and
 * cancelling would make the suggestion of a response still on screen dead.
 */
internal fun unlockPendingIntent(context: Context): PendingIntent = PendingIntent.getActivity(
    context, 0, Intent(context, AutofillUnlockActivity::class.java),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
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
        // Saving is subproject C; the responses carry no SaveInfo, so this is not expected to be called.
        callback.onSuccess()
    }
}
