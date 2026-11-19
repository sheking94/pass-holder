package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.fragment.app.FragmentActivity
import io.github.sheking94.passholder.app.FingerprintPrompt
import io.github.sheking94.passholder.app.FingerprintResult
import javax.crypto.Cipher

/**
 * Shows the system fingerprint dialog. It needs the activity, so it is shown from the screen; the ViewModel
 * only prepares the cipher and gets it back once a finger unlocked it.
 */
class FingerprintDialog(
    private val activity: FragmentActivity?,
    private val prompt: FingerprintPrompt,
    private val onError: (String) -> Unit,
) {
    /**
     * [prepare] gives the cipher to unlock, or null when there is none (it has put the reason on the status line
     * itself, or nothing should happen, e.g. while busy). Cancelling the dialog is not an error.
     */
    fun show(title: String, prepare: () -> Cipher?, onAuthorized: (Cipher) -> Unit) {
        val activity = activity ?: return
        val cipher = prepare() ?: return
        prompt.authenticate(activity, title, cipher) { result ->
            when (result) {
                is FingerprintResult.Authorized -> onAuthorized(result.cipher)
                is FingerprintResult.Failed -> onError(result.message)
                FingerprintResult.Cancelled -> {}
            }
        }
    }
}

@Composable
fun rememberFingerprintDialog(fingerprint: FingerprintActions): FingerprintDialog {
    val activity = LocalActivity.current as? FragmentActivity
    val prompt = fingerprint.prompt
    return remember(activity, prompt) { FingerprintDialog(activity, prompt, fingerprint::fail) }
}
