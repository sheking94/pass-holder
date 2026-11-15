package io.github.sheking94.passholder.app.autofill

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.AppCandidate
import io.github.sheking94.passholder.core.autofill.AppRequest
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

/** The vault's logins for [request], in `matchApp` order. */
private fun matchingLogins(request: AppRequest, entries: List<PhoneEntry>): List<PhoneEntry> =
    matchApp(request, entries.filter { it.content.fields is LoginFields }) {
        val f = it.content.fields as LoginFields
        AppCandidate(it.content.name, f.urls, f.androidApps)
    }

private fun PhoneEntry.savedLogin(): SavedLogin {
    val f = content.fields as LoginFields
    return SavedLogin(id, f.username, f.password)
}

/**
 * A submitted login checked against the vault (spec 3.2, 5.4). [entries] are the vault's entries, decrypted by the
 * caller; of the logins matching the request only what the decision and the header need is kept (id, name, login,
 * password). [appLabel] names a new login of an app.
 */
class SaveReview(val data: SaveData, entries: List<PhoneEntry>, private val appLabel: String) {
    /** Null when the address cannot be saved. */
    val target: SaveTarget? = saveTargetFor(data.app)

    private val saved: List<SavedLogin>
    private val names: Map<String, String>

    init {
        val logins = matchingLogins(data.app, entries)
        saved = logins.map { it.savedLogin() }
        names = logins.associate { it.id to it.content.name }
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
        is SaveDecision.Update -> "Zmiana hasła: ${names.getValue(d.id)}"
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
}

/**
 * Saves [draft] (spec 3.3, 5.4). The vault is read again here and the decision taken anew from what the user typed,
 * so a change made since the review started (a sync, another save) is not overwritten: a new login gets the name of
 * the draft (the default one when left blank), a changed password updates only the password of the entry as it is
 * now. [SaveOutcome.NOTHING]: the vault has this login with this password already. A locked vault, also one whose
 * deadline passed, saves nothing and reports [SaveOutcome.LOCKED].
 */
fun saveReviewed(app: PassHolderApp, review: SaveReview, draft: SaveDraft): SaveOutcome {
    val store = app.phoneStore
    // D1: the 60 s timer may not have run (deep sleep, a frozen app); the deadline still holds.
    if (app.leaveLock.expired()) store.lock()
    if (!store.isUnlocked) return SaveOutcome.LOCKED
    val target = review.target ?: return SaveOutcome.NOTHING
    val logins = matchingLogins(review.data.app, store.entries())
    return when (val decision = decideSave(draft.username, draft.password, logins.map { it.savedLogin() })) {
        SaveDecision.None -> SaveOutcome.NOTHING
        SaveDecision.Create -> {
            val name = draft.name.trim().ifEmpty { review.initialDraft().name }
            val content = newLogin(target, name, draft.username, draft.password).copy(name = name)
            store.upsertContent(UUID.randomUUID().toString(), content)
            // The app the login was saved in is the one tied to it now (V3-S3).
            if (target is SaveTarget.App) app.appTrust.rememberIfNew(target.packageName)
            SaveOutcome.SAVED
        }
        is SaveDecision.Update -> {
            val entry = logins.first { it.id == decision.id }
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
    /** Null before the review starts, after the save and while the vault is locked again (decrypted logins dropped). */
    var review: SaveReview? by mutableStateOf(null)
        private set
    /** Whether the review started: the draft is the user's then and survives a new unlock. */
    var started = false
        private set
    var draft by mutableStateOf(SaveDraft("", "", ""))
    var saving by mutableStateOf(false)
        private set
    /** Set once the save ran: the Toast text (null for none). */
    var done: Done? by mutableStateOf(null)
        private set
    /** The vault was locked when "Zapisz" came: unlock again, then the review with the same draft. */
    var lockedOut by mutableStateOf(false)

    class Done(val toast: String?)

    fun start(review: SaveReview, draft: SaveDraft) {
        this.draft = draft
        started = true
        this.review = review
    }

    /** Forgets the decrypted logins (saved, or the vault locked); the candidate and the draft stay. */
    fun dropReview() {
        review = null
        // A new unlock follows anyway; a stale flag would ask for a second one.
        lockedOut = false
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
            saving = false
            if (outcome == SaveOutcome.LOCKED) {
                lockedOut = true
                return@launch
            }
            this@SaveReviewModel.review = null
            done = Done(
                when (outcome) {
                    null -> SAVE_FAILED
                    // Saved meanwhile (a sync, another save) with this password.
                    SaveOutcome.NOTHING -> ALREADY_SAVED
                    else -> saveToast(outcome)
                },
            )
        }
    }
}

const val SAVE_FAILED = "Nie udało się zapisać w PassHolder"
const val ALREADY_SAVED = "Ten login jest już zapisany w PassHolder"
