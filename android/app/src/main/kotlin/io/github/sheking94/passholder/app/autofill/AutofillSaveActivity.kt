package io.github.sheking94.passholder.app.autofill

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import io.github.sheking94.passholder.app.PassHolderApp

/**
 * Opened by the system after the system's save question was accepted while the vault was locked. The candidate
 * waits in [PassHolderApp.pendingSave]; it is taken at unlock time, so the 2 minutes are checked when saving.
 * Finishes with RESULT_OK and no data; see [AutofillAuthActivity] for the unlock, the D1 lock and cancelling.
 */
class AutofillSaveActivity : AutofillAuthActivity() {
    // Nothing to save (expired, already taken, process restarted): close without asking for the password.
    override fun prepare(): Boolean = app.pendingSave.peek()

    override fun afterUnlock(): Intent? {
        val data = app.pendingSave.take()
        if (data == null) {
            // The candidate expired while this screen was open.
            toast("Minęły 2 minuty – zaloguj się ponownie, aby zapisać")
            return null
        }
        try {
            val outcome = saveLogin(app, data) { pkg -> appLabelOf(packageManager, pkg) }
            saveToast(outcome)?.let(::toast)
        } catch (e: Exception) {
            Log.w(PassHolderApp.TAG, "Saving the login after unlock failed", e)
            toast("Nie udało się zapisać w PassHolder")
        }
        return null
    }

    private fun toast(text: String) =
        Handler(Looper.getMainLooper()).post { Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show() }

    override fun onCancelled() = app.pendingSave.clear()
}
