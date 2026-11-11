package io.github.sheking94.passholder.app.autofill

import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.util.Log
import android.service.autofill.FillResponse
import android.view.WindowManager
import android.view.autofill.AutofillManager
import android.view.inputmethod.InlineSuggestionsRequest
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.crypto.Cipher

/**
 * Opened by the system from the "Odblokuj PassHolder" suggestion of a locked vault. After the master password
 * or the fingerprint it hands the suggestions for the same fill request back to the system
 * (EXTRA_AUTHENTICATION_RESULT) and locks again (D1): at once, or in 60 s with the lock delay on.
 * Back and "Anuluj" give RESULT_CANCELED; an unlock still running then is locked as soon as it ends.
 */
class AutofillUnlockActivity : FragmentActivity() {
    private val app get() = application as PassHolderApp
    private lateinit var request: ParsedRequest
    private var inline: InlineSuggestionsRequest? = null
    private lateinit var biometrics: BiometricController
    private lateinit var fingerprintDialog: FingerprintDialog

    private var busy by mutableStateOf(false)
    private var status by mutableStateOf<Status?>(null)
    /** The fingerprint dialog opens by itself once, on the first resume (not again after a rotation). */
    private var fingerprintOffered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No screenshots, no screen recording, as in MainActivity.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        // Any way out but a successful unlock (Back, "Anuluj", no request) gives no result.
        setResult(RESULT_CANCELED)
        val parsed = try {
            app.autofillRequest(intent)
        } catch (e: Exception) {
            Log.w(PassHolderApp.TAG, "Autofill unlock: unreadable request", e)
            null
        }
        if (parsed == null) {
            finish()
            return
        }
        request = parsed
        inline = intent.inlineSuggestionsRequest()
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
        // The system dialog needs the activity in front, so it is offered here and not in onCreate.
        if (!fingerprintOffered && biometrics.enabled.value) {
            fingerprintOffered = true
            unlockWithFingerprint()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(FINGERPRINT_OFFERED, fingerprintOffered)
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
        setResult(RESULT_CANCELED)
        finish()
    }

    /** Unlocks off the main thread (Argon2id), builds the suggestions there too, and hands them over. */
    private fun runUnlock(unlock: () -> Unit) {
        if (busy) return
        busy = true
        status = Status("Odblokowuję…")
        // Normally locked (that is why the suggestion led here), unless the app was unlocked meanwhile.
        // A vault past its 60 s deadline (the timer did not run) counts as locked: it is locked again after.
        val wasUnlocked = app.phoneStore.isUnlocked && !app.leaveLock.expired()
        lifecycleScope.launch {
            val response = try {
                withContext(Dispatchers.IO) {
                    unlock()
                    try {
                        buildFillResponse(app, request, inline)
                    } catch (e: Exception) {
                        // The vault is open; without suggestions the system just shows none.
                        Log.w(PassHolderApp.TAG, "Autofill unlock: building the response failed", e)
                        null
                    }
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
            deliver(response, relock = !wasUnlocked)
        }
    }

    /** RESULT_OK, with the suggestions when any entry matches; then D1: the vault does not stay open because of autofill. */
    private fun deliver(response: FillResponse?, relock: Boolean) {
        // "Anuluj" or Back came while the unlock ran: keep RESULT_CANCELED and lock at once, no 60 s.
        if (isFinishing) {
            if (relock) app.phoneStore.lock()
            return
        }
        setResult(RESULT_OK, response?.let { Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, it) })
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

/** The screen the suggestion was shown for; the system puts it into the intent of the unlock screen. */
internal fun Intent.assistStructure(): AssistStructure? = parcelable(AutofillManager.EXTRA_ASSIST_STRUCTURE)

/** The keyboard's request for suggestions in its strip (API 30+), for the response after the unlock. */
private fun Intent.inlineSuggestionsRequest(): InlineSuggestionsRequest? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) parcelable(AutofillManager.EXTRA_INLINE_SUGGESTIONS_REQUEST) else null

private inline fun <reified T : Parcelable> Intent.parcelable(name: String): T? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getParcelableExtra(name, T::class.java)
    else @Suppress("DEPRECATION") (getParcelableExtra(name) as? T)
