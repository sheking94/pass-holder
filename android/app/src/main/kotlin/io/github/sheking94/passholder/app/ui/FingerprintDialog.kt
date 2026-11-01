package io.github.sheking94.passholder.app.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.FingerprintPrompt
import io.github.sheking94.passholder.app.PassHolderApp
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
        prompt.authenticate(activity, title, cipher, onSuccess = onAuthorized, onError = { message -> message?.let(onError) })
    }
}

@Composable
fun rememberFingerprintDialog(vm: AppViewModel): FingerprintDialog {
    val activity = LocalActivity.current as? FragmentActivity
    // The prompt is replaced in tests (Robolectric has no fingerprint reader), so it is read from the app.
    val prompt = (LocalContext.current.applicationContext as PassHolderApp).fingerprintPrompt
    return remember(activity, prompt) { FingerprintDialog(activity, prompt, vm::fail) }
}
