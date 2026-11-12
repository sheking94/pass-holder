package io.github.sheking94.passholder.app

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import io.github.sheking94.passholder.app.autofill.SaveDraft
import io.github.sheking94.passholder.app.ui.PassHolderTheme
import io.github.sheking94.passholder.app.ui.SaveReviewScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The review before saving a new login of a site: name, login, hidden password, the address read-only. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class SaveReviewScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `save review screenshot`() {
        compose.setContent {
            PassHolderTheme {
                Surface(Modifier.fillMaxSize()) {
                    SaveReviewScreen(
                        title = "Nowy login",
                        isNew = true,
                        draft = SaveDraft("github.com", "jan.kowalski@example.com", "Tajne-haslo-2026"),
                        place = "Strona: github.com",
                        canSave = true,
                        saving = false,
                        onDraftChange = {},
                        onSave = {},
                        onCancel = {},
                    )
                }
            }
        }
        compose.onNodeWithText("Zapisz w PassHolder").assertExists()
        compose.onNodeWithText("Nazwa").assertExists()
        compose.onNodeWithText("Pokaż").assertExists()
        compose.onNodeWithText("Strona: github.com").assertExists()
        compose.onRoot().captureRoboImage("screenshots/63-podglad-zapisu.png")
    }
}
