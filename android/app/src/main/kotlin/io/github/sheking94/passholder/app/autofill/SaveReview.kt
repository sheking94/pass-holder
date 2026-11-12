package io.github.sheking94.passholder.app.autofill

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.AppCandidate
import io.github.sheking94.passholder.core.autofill.matchApp
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.PhoneEntry
import io.github.sheking94.passholder.core.save.SaveDecision
import io.github.sheking94.passholder.core.save.SaveTarget
import io.github.sheking94.passholder.core.save.SavedLogin
import io.github.sheking94.passholder.core.save.decideSave
import io.github.sheking94.passholder.core.save.newLogin
import io.github.sheking94.passholder.core.save.saveTargetFor
import io.github.sheking94.passholder.core.save.withPassword
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/** What the user is about to save, as edited on the review screen. */
data class SaveDraft(val name: String, val username: String, val password: String) {
    // Never print the password (logs, crash reports).
    override fun toString() = "SaveDraft(name=$name)"
}

/**
 * A submitted login checked against the vault (spec 3.2, 5.4). [entries] are the vault's entries, decrypted by the
 * caller; only the logins matching the request are kept. [appLabel] names a new login of an app.
 */
class SaveReview(val data: SaveData, entries: List<PhoneEntry>, private val appLabel: String) {
    /** Null when the address cannot be saved. */
    val target: SaveTarget? = saveTargetFor(data.app)

    private val logins: List<PhoneEntry> = matchApp(data.app, entries.filter { it.content.fields is LoginFields }) {
        val f = it.content.fields as LoginFields
        AppCandidate(it.content.name, f.urls, f.androidApps)
    }
    private val saved = logins.map {
        val f = it.content.fields as LoginFields
        SavedLogin(it.id, f.username, f.password)
    }

    fun decision(draft: SaveDraft): SaveDecision = decideSave(draft.username, draft.password, saved)

    /** The submitted login; the name as a new entry would get it (spec 3.3). */
    fun initialDraft(): SaveDraft {
        val name = target?.let { newLogin(it, appLabel, "", "").name }.orEmpty()
        return SaveDraft(name, data.username, data.password)
    }

    /** "Nowy login" or "Zmiana hasła: <entry>"; while the password is empty, what saving would do once typed. */
    fun title(draft: SaveDraft): String = when (val d = intent(draft)) {
        SaveDecision.Create -> "Nowy login"
        is SaveDecision.Update -> "Zmiana hasła: ${entry(d.id).content.name}"
        SaveDecision.None -> "Ten login jest już zapisany"
    }

    /** Whether [draft] makes a new entry (it then has a name to edit); with an empty password as in [title]. */
    fun createsEntry(draft: SaveDraft): Boolean = intent(draft) == SaveDecision.Create

    /** Where the login is saved, read-only on the screen. */
    val place: String = when (val t = target) {
        is SaveTarget.Web -> "Strona: ${t.url}"
        is SaveTarget.App -> if (appLabel == t.packageName) "Aplikacja: $appLabel" else "Aplikacja: $appLabel (${t.packageName})"
        null -> ""
    }

    private fun intent(draft: SaveDraft): SaveDecision {
        // A password longer than every saved one equals none of them, so only the username decides.
        val probe = draft.password.ifEmpty { saved.joinToString("") { it.password } + "x" }
        return decision(draft.copy(password = probe))
    }

    internal fun entry(id: String): PhoneEntry = logins.first { it.id == id }
}

/**
 * Saves [draft] (spec 3.3, 5.4), deciding again from what the user typed: a new login gets the name of the draft
 * (the default one when left blank), a changed password updates only the password. A locked vault, also one whose
 * deadline passed, saves nothing and reports [SaveOutcome.LOCKED].
 */
fun saveReviewed(app: PassHolderApp, review: SaveReview, draft: SaveDraft): SaveOutcome {
    val store = app.phoneStore
    // D1: the 60 s timer may not have run (deep sleep, a frozen app); the deadline still holds.
    if (app.leaveLock.expired()) store.lock()
    if (!store.isUnlocked) return SaveOutcome.LOCKED
    val target = review.target ?: return SaveOutcome.NOTHING
    return when (val decision = review.decision(draft)) {
        SaveDecision.None -> SaveOutcome.NOTHING
        SaveDecision.Create -> {
            val name = draft.name.trim().ifEmpty { review.initialDraft().name }
            val content = newLogin(target, name, draft.username, draft.password).copy(name = name)
            store.upsertContent(UUID.randomUUID().toString(), content)
            SaveOutcome.SAVED
        }
        is SaveDecision.Update -> {
            val entry = review.entry(decision.id)
            store.upsertContent(entry.id, withPassword(entry.content, draft.password))
            SaveOutcome.UPDATED
        }
    }
}

/**
 * The review screen's state: survives a rotation, never in the saved instance state or an Intent (spec 5.4). The
 * candidate is kept here once taken from [PassHolderApp.pendingSave]; the decrypted logins live in [review].
 */
class SaveReviewModel : ViewModel() {
    var candidate: SaveData? = null
    var review: SaveReview? by mutableStateOf(null)
    var draft by mutableStateOf(SaveDraft("", "", ""))
    var saving by mutableStateOf(false)
        private set
    /** Set once the save ran: the Toast text (null for none). */
    var done: Done? by mutableStateOf(null)
        private set

    class Done(val toast: String?)

    fun start(review: SaveReview, draft: SaveDraft) {
        this.draft = draft
        this.review = review
    }

    /** Saves [draft] off the main thread; in this scope, so a rotation neither stops nor repeats it. */
    fun save(app: PassHolderApp) {
        val review = review ?: return
        if (saving) return
        saving = true
        val draft = draft
        viewModelScope.launch {
            val outcome = withContext(Dispatchers.IO) {
                try {
                    saveReviewed(app, review, draft)
                } catch (e: Exception) {
                    Log.w(PassHolderApp.TAG, "Saving the reviewed login failed", e)
                    null
                }
            }
            done = Done(if (outcome == null || outcome == SaveOutcome.LOCKED) SAVE_FAILED else saveToast(outcome))
        }
    }
}

const val SAVE_FAILED = "Nie udało się zapisać w PassHolder"
