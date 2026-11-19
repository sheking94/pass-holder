package io.github.sheking94.passholder.app.autofill

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.addCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.lifecycleScope
import io.github.sheking94.passholder.app.BiometricController
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.Status
import io.github.sheking94.passholder.app.UiTexts
import io.github.sheking94.passholder.app.errorMessage
import io.github.sheking94.passholder.app.ui.AutofillUnlockScreen
import io.github.sheking94.passholder.app.ui.FingerprintDialog
import io.github.sheking94.passholder.app.ui.PassHolderTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.crypto.Cipher

/** What the subclass does once the vault is open. */
sealed interface AfterUnlock {
    /** Close with RESULT_OK and [data] (null for none), locking again (D1). */
    class Deliver(val data: Intent?) : AfterUnlock

    /** Keep the screen open with [AutofillAuthActivity.UnlockedContent]; it closes with finishAfterUnlock or Back. */
    data object Stay : AfterUnlock
}

/**
 * Where the autofill screen is. Kept in [AuthScreenState] (a ViewModel): [Open] survives a rotation, dies with the
 * process (and so with the open vault), never goes into the saved instance state.
 */
internal sealed interface AuthPhase {
    /** The unlock screen; [busy] while an unlock and the work after it run. */
    data class Locked(val busy: Boolean = false) : AuthPhase

    /** The vault was open at the start ([AutofillAuthActivity.skipsUnlockWhenOpen]): the work runs behind a blank screen. */
    data object Skipping : AuthPhase

    /**
     * After [AfterUnlock.Stay]: [AutofillAuthActivity.UnlockedContent] is shown. [locksOnLeave]: leaving locks the
     * vault (D1); false when the vault was open already, the app then keeps its own lock timing. [lockStarted]:
     * onStop already started that lock (the 60 s timer runs), so closing must not start it again, which would move
     * the deadline (or lock a vault reopened in the app meanwhile).
     */
    data class Open(val locksOnLeave: Boolean, val lockStarted: Boolean = false) : AuthPhase

    /** RESULT_OK is set and the activity is finishing. */
    data object Delivered : AuthPhase
}

internal class AuthScreenState : ViewModel() {
    var phase: AuthPhase by mutableStateOf(AuthPhase.Locked())
}

/**
 * The unlock screen shared by the autofill activities, started by the system from a PendingIntent. After the
 * master password or the fingerprint the subclass does its work ([afterUnlock]) and the vault locks again (D1):
 * at once, or in 60 s with the lock delay on; a subclass that stays open ([AfterUnlock.Stay]) locks it when it
 * closes. Back and "Anuluj" give RESULT_CANCELED; an unlock still running then is locked as soon as it ends.
 *
 * D1 is decision D1 in docs/ARCHITEKTURA.md, section "Przepływ autouzupełniania (Android)": after an unlock for
 * autofill the vault locks as after leaving the app, unless the app had it open already.
 */
abstract class AutofillAuthActivity : FragmentActivity() {
    protected val app get() = application as PassHolderApp
    private val screen: AuthScreenState by viewModels()
    private lateinit var biometrics: BiometricController
    private lateinit var fingerprintDialog: FingerprintDialog

    private var phase: AuthPhase
        get() = screen.phase
        set(value) {
            screen.phase = value
        }
    private val busy: Boolean get() = phase.let { it is AuthPhase.Skipping || (it is AuthPhase.Locked && it.busy) }
    private var status by mutableStateOf<Status?>(null)

    /** The fingerprint dialog opens by itself once, on the first resume (not again after a rotation). */
    private var fingerprintOffered = false

    /** Reads what the activity was started for; false when there is nothing to do, and the activity closes. */
    protected abstract fun prepare(): Boolean

    /** Runs on Dispatchers.IO with the vault open (again after a rotation that interrupted it). */
    protected abstract fun afterUnlock(): AfterUnlock

    /** Whether a vault open at the start goes straight to [afterUnlock]; it is then not locked afterwards. */
    protected open val skipsUnlockWhenOpen = false

    /** The screen after [AfterUnlock.Stay]. */
    @Composable
    protected open fun UnlockedContent() {}

    /** False while Back must do nothing (e.g. a save is running). */
    protected open val canCancel: Boolean get() = true

    /** The vault locked while [UnlockedContent] was open; the unlock screen is back. Drop what was decrypted. */
    protected open fun onLockedWhileOpen() {}

    /** Back, "Anuluj" or a close before the unlock finished (may run twice): drop what [prepare] kept. */
    protected open fun onCancelled() {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No screenshots, no screen recording, as in MainActivity.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        // Any way out but a successful unlock (Back, "Anuluj", nothing to do) gives no result.
        setResult(RESULT_CANCELED)
        if (!prepare()) {
            finish()
            return
        }
        biometrics = BiometricController(app.biometric)
        fingerprintDialog = FingerprintDialog(this, app.fingerprintPrompt) { status = Status(it, isError = true) }
        fingerprintOffered = savedInstanceState?.getBoolean(FINGERPRINT_OFFERED) ?: false
        startPhase()
        // Back must cancel like "Anuluj", also while an unlock is running (nothing may be saved then).
        onBackPressedDispatcher.addCallback(this) { if (canCancel) cancel() }
        enableEdgeToEdge()
        setContent { Content() }
    }

    /**
     * Past the unlock already (a rotation): [AuthPhase.Open] stays. Otherwise the unlock screen, or straight to the
     * work when the vault is open. Work interrupted by a rotation was cancelled with the old activity and starts anew.
     */
    private fun startPhase() {
        if (phase is AuthPhase.Open) {
            fingerprintOffered = true
            return
        }
        phase = AuthPhase.Locked()
        if (skipsUnlockWhenOpen && app.phoneStore.isUnlocked && !app.leaveLock.expired()) {
            fingerprintOffered = true
            continueWithOpenVault()
        }
    }

    @Composable
    private fun Content() {
        val fingerprint by biometrics.enabled.collectAsState()
        PassHolderTheme {
            Surface(Modifier.fillMaxSize()) {
                Box(Modifier.safeDrawingPadding()) {
                    when (phase) {
                        is AuthPhase.Open -> UnlockedContent()

                        // Blank for the moment afterUnlock takes, and while finishing.
                        AuthPhase.Skipping, AuthPhase.Delivered -> {}

                        is AuthPhase.Locked -> AutofillUnlockScreen(
                            busy,
                            status,
                            fingerprint,
                            ::unlockWithPassword,
                            ::unlockWithFingerprint,
                            ::cancel,
                        )
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        val open = phase as? AuthPhase.Open ?: return
        // D1: the 60 s timer may not have run (deep sleep, a frozen app); the deadline still holds.
        app.leaveLock.lockIfExpired()
        if (!app.phoneStore.isUnlocked) {
            unlockAgain()
        } else if (open.lockStarted) {
            // Back in front before the timer of onStop ran out.
            app.leaveLock.cancel()
            phase = open.copy(lockStarted = false)
        }
    }

    override fun onStop() {
        super.onStop()
        val open = phase as? AuthPhase.Open ?: return
        // Left in the background (not a rotation, not closing): D1 as if it had closed. onStart takes it back.
        if (open.locksOnLeave && !isChangingConfigurations && !isFinishing) {
            lockAfterUse()
            // Locked at once (no delay): drop the decrypted data now, not on return.
            if (app.phoneStore.isUnlocked) phase = open.copy(lockStarted = true) else unlockAgain()
        }
    }

    override fun onResume() {
        super.onResume()
        // prepare() said no: finishing, nothing was set up. The system dialog needs the activity in front,
        // so it is offered here and not in onCreate.
        if (isFinishing) return
        if (!fingerprintOffered && biometrics.enabled.value) {
            fingerprintOffered = true
            unlockWithFingerprint()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(FINGERPRINT_OFFERED, fingerprintOffered)
    }

    override fun onDestroy() {
        // Closed for good without a successful unlock (Back included); a rotation is not that.
        if (isFinishing && phase != AuthPhase.Delivered) onCancelled()
        // Closed for good, also by the system without finishing: the vault this screen opened is locked (D1).
        if (!isChangingConfigurations) leaveUnlocked()
        super.onDestroy()
    }

    private fun unlockWithPassword(masterPassword: String) = unlockAndContinue { app.phoneStore.unlock(masterPassword) }

    private fun unlockWithFingerprint() {
        if (busy) return
        fingerprintDialog.show(UiTexts.UNLOCK_TITLE, ::cipherToUnlock) { cipher ->
            unlockAndContinue { biometrics.unlock(cipher, app.phoneStore::unlockWithVaultKey) }
        }
    }

    /** The cipher for the dialog, or null with the reason on the status line (the password still works). */
    private fun cipherToUnlock(): Cipher? = try {
        biometrics.cipherToUnlock()
    } catch (e: Exception) {
        status = Status(errorMessage(e), isError = true)
        null
    }

    /** Back or "Anuluj": RESULT_CANCELED; after [AfterUnlock.Stay] the vault is locked as after a delivery. */
    protected fun cancel() {
        onCancelled()
        setResult(RESULT_CANCELED)
        leaveUnlocked()
        finish()
    }

    /** Ends a screen kept open by [AfterUnlock.Stay]: RESULT_OK with [data], then D1 if this screen unlocked. */
    protected fun finishAfterUnlock(data: Intent?) {
        val open = phase as? AuthPhase.Open ?: return
        phase = AuthPhase.Locked()
        deliver(data, relock = open.locksOnLeave && !open.lockStarted)
    }

    /**
     * The vault was locked while [UnlockedContent] was open (a delayed lock, the app's own lock): back to the unlock
     * screen; the next unlock runs [afterUnlock] again and counts as this screen's (locked again at the end).
     */
    protected fun unlockAgain() {
        if (phase !is AuthPhase.Open) return
        phase = AuthPhase.Locked()
        status = Status("PassHolder się zablokował – odblokuj ponownie")
        onLockedWhileOpen()
    }

    /** D1 for a screen kept open by [AfterUnlock.Stay] that closes without delivering; at most once. */
    private fun leaveUnlocked() {
        val open = phase as? AuthPhase.Open ?: return
        phase = AuthPhase.Locked()
        if (open.locksOnLeave && !open.lockStarted) lockAfterUse()
    }

    /** The master password or the fingerprint: [unlock] runs off the main thread (Argon2id), then the work. */
    private fun unlockAndContinue(unlock: () -> Unit) {
        if (busy) return
        status = Status("Odblokowuję…")
        continueUnlocked(unlock)
    }

    /** The vault is already open ([skipsUnlockWhenOpen]): only the work, behind a blank screen. */
    private fun continueWithOpenVault() {
        phase = AuthPhase.Skipping
        continueUnlocked(unlock = {})
    }

    /** Runs [unlock] and the subclass's work off the main thread, and hands the result over. */
    private fun continueUnlocked(unlock: () -> Unit) {
        if (phase is AuthPhase.Locked) phase = AuthPhase.Locked(busy = true)
        // Normally locked (that is why the user came here), unless the app was unlocked meanwhile.
        // A vault past its 60 s deadline (the timer did not run) counts as locked: it is locked again after.
        val wasUnlocked = app.phoneStore.isUnlocked && !app.leaveLock.expired()
        lifecycleScope.launch {
            val next = try {
                withContext(Dispatchers.IO) {
                    unlock()
                    // A deadline left by an earlier delayed lock stays "expired" until cancelled, and would
                    // make the work below see a locked vault; deliver() schedules a fresh one.
                    if (!wasUnlocked) app.leaveLock.cancel()
                    // Closed while the unlock ran: do not act on it any more.
                    ensureActive()
                    afterUnlock()
                }
            } catch (e: CancellationException) {
                // Closed (Back, "Anuluj", rotation) while the unlock ran: withContext waited for it, so the
                // vault may be open now with nobody to lock it.
                if (!wasUnlocked) app.phoneStore.lock()
                throw e
            } catch (e: Exception) {
                // The phase lives in the ViewModel: a closed (rotated) screen must not change the new one's.
                if (!isActive) return@launch
                // Wrong password and the like: the same message as on the locked screen of the app.
                phase = AuthPhase.Locked()
                status = Status(errorMessage(e), isError = true)
                return@launch
            }
            when (next) {
                is AfterUnlock.Deliver -> deliver(next.data, relock = !wasUnlocked)

                AfterUnlock.Stay -> {
                    status = null
                    // Remembered across a rotation; the screen locks the vault when it closes.
                    phase = AuthPhase.Open(locksOnLeave = !wasUnlocked)
                }
            }
        }
    }

    /** RESULT_OK, with [data] when any; then D1 when [relock]: the vault does not stay open because of autofill. */
    private fun deliver(data: Intent?, relock: Boolean) {
        // "Anuluj" or Back came while the unlock ran: keep RESULT_CANCELED and lock at once, no 60 s.
        if (isFinishing) {
            if (relock) app.phoneStore.lock()
            return
        }
        phase = AuthPhase.Delivered
        setResult(RESULT_OK, data)
        // A vault the app itself had open already keeps the app's own lock timing.
        if (relock) lockAfterUse()
        finish()
    }

    /** D1: at once, or in 60 s with the lock delay on. */
    private fun lockAfterUse() {
        if (app.settings.lockDelay) app.leaveLock.schedule() else app.phoneStore.lock()
    }

    private companion object {
        const val FINGERPRINT_OFFERED = "fingerprintOffered"
    }
}
