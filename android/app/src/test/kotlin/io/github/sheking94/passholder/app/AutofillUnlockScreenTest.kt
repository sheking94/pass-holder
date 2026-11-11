package io.github.sheking94.passholder.app

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import io.github.sheking94.passholder.app.ui.AutofillUnlockScreen
import io.github.sheking94.passholder.app.ui.PassHolderTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The unlock screen of an autofill suggestion, with fingerprint unlock on and a wrong password typed. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class AutofillUnlockScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `unlock screen screenshot`() {
        compose.setContent {
            PassHolderTheme {
                Surface(Modifier.fillMaxSize()) {
                    AutofillUnlockScreen(
                        busy = false,
                        status = Status("Złe hasło główne", isError = true),
                        fingerprint = true,
                        onUnlock = {},
                        onFingerprint = {},
                        onCancel = {},
                    )
                }
            }
        }
        compose.onNodeWithText("Odblokuj PassHolder").assertExists()
        compose.onNodeWithText("Odblokuj odciskiem palca").assertExists()
        compose.onNodeWithText("Anuluj").assertExists()
        compose.onRoot().captureRoboImage("screenshots/51-autouzupelnianie-odblokuj.png")
    }
}
