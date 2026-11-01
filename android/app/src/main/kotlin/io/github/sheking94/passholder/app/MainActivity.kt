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
        // Coming back after a while: lock first if the idle time has run out.
        viewModel.checkAutoLock()
    }

    /**
     * The app left the screen: Home, the recent apps list, another app on top, the screen turned off, or the
     * activity closed with Back. Lock right away, so every return asks for the fingerprint or the master
     * password. A screen rotation also stops the activity, but it comes straight back: no lock then.
     */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) viewModel.lockOnLeave()
    }

    /** Any touch or key press counts as activity for the auto-lock. */
    override fun onUserInteraction() {
        super.onUserInteraction()
        viewModel.touch()
    }
}
