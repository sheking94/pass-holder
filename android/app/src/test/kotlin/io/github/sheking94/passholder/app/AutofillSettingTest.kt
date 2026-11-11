package io.github.sheking94.passholder.app

import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf

/** A fake autofill state the test can flip, as if the user changed it in the system settings. */
class FakeAutofillStatus(var enabled: Boolean) : AutofillStatus {
    override fun isEnabled() = enabled
}

class AutofillSettingOffTest : ScreenTestBase() {
    private val status = FakeAutofillStatus(enabled = false)

    override fun beforeLaunch(app: PassHolderApp) {
        app.autofillStatus = status
    }

    @Test
    fun `autofill off shows Wyłączone, Włącz opens the system picker, and the state refreshes on return`() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        createVault()
        menu("Ustawienia")
        waitFor("Autouzupełnianie")
        waitFor("Wyłączone")
        shot("52-ustawienia-autouzupelnianie")

        click("Włącz")
        val intent = shadowOf(app).nextStartedActivity
        assertEquals(AndroidSettings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, intent.action)
        assertEquals(Uri.parse("package:" + app.packageName), intent.data)

        // The user turned PassHolder on in the system settings and came back.
        status.enabled = true
        scenario.moveToState(Lifecycle.State.STARTED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("Włączone")
        assertTrue(gone("Wyłączone"))
        assertTrue(compose.onAllNodes(androidx.compose.ui.test.hasText("Włącz")).fetchSemanticsNodes().isEmpty())
    }
}

class AutofillSettingOnTest : ScreenTestBase() {
    override fun beforeLaunch(app: PassHolderApp) {
        app.autofillStatus = FakeAutofillStatus(enabled = true)
    }

    @Test
    fun `autofill on shows Włączone without the Włącz button`() {
        createVault()
        menu("Ustawienia")
        waitFor("Autouzupełnianie")
        waitFor("Włączone")
        assertTrue(gone("Wyłączone"))
        assertTrue(compose.onAllNodes(androidx.compose.ui.test.hasText("Włącz")).fetchSemanticsNodes().isEmpty())
    }
}
