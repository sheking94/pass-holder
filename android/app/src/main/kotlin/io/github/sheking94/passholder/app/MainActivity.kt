package io.github.sheking94.passholder.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import io.github.sheking94.passholder.app.ui.PassHolderUi

class MainActivity : ComponentActivity() {
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

    /** Any touch or key press counts as activity for the auto-lock. */
    override fun onUserInteraction() {
        super.onUserInteraction()
        viewModel.touch()
    }
}
