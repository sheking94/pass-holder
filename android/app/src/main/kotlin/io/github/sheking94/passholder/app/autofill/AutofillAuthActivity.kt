package io.github.sheking94.passholder.app.autofill

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import io.github.sheking94.passholder.app.BiometricController
import io.github.sheking94.passholder.app.LeaveLock
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.app.Status
import io.github.sheking94.passholder.app.ui.AutofillUnlockScreen
import io.github.sheking94.passholder.app.ui.FingerprintDialog
import io.github.sheking94.passholder.app.ui.PassHolderTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.crypto.Cipher

/**
 * The unlock screen shared by the autofill activities, started by the system from a PendingIntent. After the
 * master password or the fingerprint the subclass does its work ([afterUnlock]) and the vault locks again (D1):
 * at once, or in 60 s with the lock delay on. Back and "Anuluj" give RESULT_CANCELED; an unlock still running
 * then is locked as soon as it ends.
 */
abstract class AutofillAuthActivity : FragmentActivity() {
    protected val app get() = application as PassHolderApp
    private lateinit var biometrics: BiometricController
    private lateinit var fingerprintDialog: FingerprintDialog

    private var busy by mutableStateOf(false)
    private var status by mutableStateOf<Status?>(null)
    /** The fingerprint dialog opens by itself once, on the first resume (not again after a rotation). */
    private var fingerprintOffered = false
    private var delivered = false

    /** Reads what the activity was started for; false when there is nothing to do, and the activity closes. */
    protected abstract fun prepare(): Boolean

    /** Runs on Dispatchers.IO with the vault open; the result is the data of RESULT_OK (null for none). */
    protected abstract fun afterUnlock(): Intent?

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

        enableEdgeToEdge()
        setContent {
            val fingerprint by biometrics.enabled.collectAsState()
            PassHolderTheme {
                Surface(Modifier.fillMaxSize()) {
                    Box(Modifier.safeDrawingPadding()) {
                        AutofillUnlockScreen(busy, status, fingerprint, ::unlockWithPassword, ::unlockWithFingerprint, ::cancel)
                    }
                }
            }
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
        if (isFinishing && !delivered) onCancelled()
        super.onDestroy()
    }

    private fun unlockWithPassword(masterPassword: String) = runUnlock { app.phoneStore.unlock(masterPassword) }

    private fun unlockWithFingerprint() {
        if (busy) return
        fingerprintDialog.show("Odblokuj PassHolder", ::cipherToUnlock) { cipher ->
            runUnlock { biometrics.unlock(cipher, app.phoneStore::unlockWithKeys) }
        }
    }

    /** The cipher for the dialog, or null with the reason on the status line (the password still works). */
    private fun cipherToUnlock(): Cipher? = try {
        biometrics.cipherToUnlock()
    } catch (e: Exception) {
        status = Status(e.message ?: e.javaClass.simpleName, isError = true)
        null
    }

    private fun cancel() {
        onCancelled()
        setResult(RESULT_CANCELED)
        finish()
    }

    /** Unlocks off the main thread (Argon2id), does the subclass's work there too, and hands the result over. */
    private fun runUnlock(unlock: () -> Unit) {
        if (busy) return
        busy = true
        status = Status("Odblokowuję…")
        // Normally locked (that is why the user came here), unless the app was unlocked meanwhile.
        // A vault past its 60 s deadline (the timer did not run) counts as locked: it is locked again after.
        val wasUnlocked = app.phoneStore.isUnlocked && !app.leaveLock.expired()
        lifecycleScope.launch {
            val data = try {
                withContext(Dispatchers.IO) {
                    unlock()
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
                // Wrong password and the like: the same message as on the locked screen of the app.
                busy = false
                status = Status(e.message ?: e.javaClass.simpleName, isError = true)
                return@launch
            }
            deliver(data, relock = !wasUnlocked)
        }
    }

    /** RESULT_OK, with [data] when any; then D1: the vault does not stay open because of autofill. */
    private fun deliver(data: Intent?, relock: Boolean) {
        // "Anuluj" or Back came while the unlock ran: keep RESULT_CANCELED and lock at once, no 60 s.
        if (isFinishing) {
            if (relock) app.phoneStore.lock()
            return
        }
        delivered = true
        setResult(RESULT_OK, data)
        // A vault the app itself had open already keeps the app's own lock timing.
        if (relock) {
            if (app.settings.lockDelay) app.leaveLock.schedule(LeaveLock.DELAY_MS) else app.phoneStore.lock()
        }
        finish()
    }

    private companion object {
        const val FINGERPRINT_OFFERED = "fingerprintOffered"
    }
}
