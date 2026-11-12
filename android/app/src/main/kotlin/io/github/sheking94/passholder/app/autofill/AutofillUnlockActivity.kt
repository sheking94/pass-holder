package io.github.sheking94.passholder.app.autofill

import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.Parcelable
import android.util.Log
import android.view.autofill.AutofillManager
import android.view.inputmethod.InlineSuggestionsRequest
import io.github.sheking94.passholder.app.PassHolderApp

/**
 * Opened by the system from the "Odblokuj PassHolder" suggestion of a locked vault. After the master password
 * or the fingerprint it hands the suggestions for the same fill request back to the system
 * (EXTRA_AUTHENTICATION_RESULT); see [AutofillAuthActivity] for the unlock, the D1 lock and cancelling.
 */
class AutofillUnlockActivity : AutofillAuthActivity() {
    private lateinit var request: ParsedRequest
    private var inline: InlineSuggestionsRequest? = null

    override fun prepare(): Boolean {
        val parsed = try {
            app.autofillRequest(intent)
        } catch (e: Exception) {
            Log.w(PassHolderApp.TAG, "Autofill unlock: unreadable request", e)
            null
        } ?: return false
        request = parsed
        inline = intent.inlineSuggestionsRequest()
        return true
    }

    override fun afterUnlock(): AfterUnlock {
        val response = try {
            buildFillResponse(app, request, inline)
        } catch (e: Exception) {
            // The vault is open; without suggestions the system just shows none.
            Log.w(PassHolderApp.TAG, "Autofill unlock: building the response failed", e)
            null
        }
        return AfterUnlock.Deliver(response?.let { Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, it) })
    }
}

/** The screen the suggestion was shown for; the system puts it into the intent of the unlock screen. */
internal fun Intent.assistStructure(): AssistStructure? = parcelable(AutofillManager.EXTRA_ASSIST_STRUCTURE)

/** The keyboard's request for suggestions in its strip (API 30+), for the response after the unlock. */
private fun Intent.inlineSuggestionsRequest(): InlineSuggestionsRequest? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) parcelable(AutofillManager.EXTRA_INLINE_SUGGESTIONS_REQUEST) else null

private inline fun <reified T : Parcelable> Intent.parcelable(name: String): T? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getParcelableExtra(name, T::class.java)
    else @Suppress("DEPRECATION") (getParcelableExtra(name) as? T)
