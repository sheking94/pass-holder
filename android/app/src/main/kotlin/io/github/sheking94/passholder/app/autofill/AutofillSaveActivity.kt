package io.github.sheking94.passholder.app.autofill

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.ui.SaveReviewScreen
import io.github.sheking94.passholder.core.save.SaveDecision

/**
 * Opened by the system after its save question was accepted (Android 9+, spec 5.4): the unlock when the vault is
 * locked, then the review of the login, editable, before it is saved. The candidate waits in
 * [PassHolderApp.pendingSave] and is taken when the review starts, so the 2 minutes are checked then. Finishes with
 * RESULT_OK after "Zapisz" (or when there is nothing to review); see [AutofillAuthActivity] for the unlock, the D1
 * lock when the review ends and cancelling.
 */
class AutofillSaveActivity : AutofillAuthActivity() {
    private val model: SaveReviewModel by viewModels()

    override val skipsUnlockWhenOpen = true

    // Nothing to save (expired, already taken, process restarted): close without asking for the password.
    // After a rotation the candidate is in the model already.
    override fun prepare(): Boolean = model.review != null || model.candidate != null || app.pendingSave.peek()

    override fun afterUnlock(): AfterUnlock {
        if (model.review != null) return AfterUnlock.Stay
        val data = model.candidate ?: app.pendingSave.take()?.also { model.candidate = it }
        if (data == null) {
            // The candidate expired while this screen was open.
            toast("Minęły 2 minuty – zaloguj się ponownie, aby zapisać")
            return AfterUnlock.Deliver(null)
        }
        val review = try {
            // Decrypted once here; kept in memory only while this screen lives.
            SaveReview(data, app.phoneStore.entries(), appLabelOf(packageManager, data.app.packageName))
        } catch (e: Exception) {
            Log.w(PassHolderApp.TAG, "Reading the vault for the save review failed", e)
            toast(SAVE_FAILED)
            return AfterUnlock.Deliver(null)
        }
        // An address that cannot be saved: nothing to ask about.
        if (review.target == null) return AfterUnlock.Deliver(null)
        val draft = review.initialDraft()
        if (review.decision(draft) == SaveDecision.None) {
            toast("Ten login jest już zapisany w PassHolder")
            return AfterUnlock.Deliver(null)
        }
        model.start(review, draft)
        return AfterUnlock.Stay
    }

    @Composable
    override fun UnlockedContent() {
        val review = model.review ?: return
        val draft = model.draft
        val done = model.done
        if (done != null) {
            LaunchedEffect(done) {
                done.toast?.let(::toast)
                finishAfterUnlock(null)
            }
        }
        SaveReviewScreen(
            title = review.title(draft),
            isNew = review.createsEntry(draft),
            draft = draft,
            place = review.place,
            canSave = review.decision(draft) != SaveDecision.None,
            saving = model.saving,
            onDraftChange = { model.draft = it },
            onSave = { model.save(app) },
            onCancel = ::cancel,
        )
    }

    private fun toast(text: String) =
        Handler(Looper.getMainLooper()).post { Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show() }

    override fun onCancelled() = app.pendingSave.clear()
}
