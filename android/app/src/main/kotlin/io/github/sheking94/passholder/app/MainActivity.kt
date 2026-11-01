package io.github.sheking94.passholder.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.fragment.app.FragmentActivity
import io.github.sheking94.passholder.app.ui.PassHolderUi

/** A FragmentActivity (still a ComponentActivity) because the system fingerprint dialog needs one. */
class MainActivity : FragmentActivity() {
    private val viewModel: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No screenshots, no screen recording, and a blank thumbnail in the recent apps list.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        setContent { PassHolderUi(viewModel) }
    }

    override fun onStart() {
        super.onStart()
        // Back in the app: lock now if the 60 s after leaving have run out, then the 15-minute idle check.
        viewModel.onReturn()
        viewModel.checkAutoLock()
    }

    /**
     * The app left the screen: Home, the recent apps list, another app on top, the screen turned off, or the
     * activity closed with Back. Lock (at once, or after 60 s with the delay on), so opening the app again asks
     * for the fingerprint or the master password. A screen rotation also stops the activity, but it comes
     * straight back: nothing happens then.
     */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) viewModel.onLeftApp()
    }

    /** Any touch or key press counts as activity for the auto-lock. */
    override fun onUserInteraction() {
        super.onUserInteraction()
        viewModel.touch()
    }
}
