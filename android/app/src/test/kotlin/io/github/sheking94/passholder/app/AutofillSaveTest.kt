package io.github.sheking94.passholder.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.autofill.AutofillSaveActivity
import io.github.sheking94.passholder.app.autofill.SaveData
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

/**
 * Saving a login submitted while the vault was locked: the service left a candidate in [PassHolderApp.pendingSave],
 * the system starts this screen. One test per class (Compose test roots leak between tests in one JVM).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
abstract class AutofillSaveTestBase {
    @get:Rule
    val compose = createEmptyComposeRule()
    protected lateinit var scenario: ActivityScenario<AutofillSaveActivity>
    protected val app: PassHolderApp = ApplicationProvider.getApplicationContext()
    protected val masterPassword = "Zażółć gęślą jaźń 2026"
    protected open val lockDelay = false
    private var now = 1_000_000L

    @Before
    fun start() {
        app.secretWrapper = TestSecretWrapper
        app.biometric = BiometricUnlock(app, SoftwareKeyProtector())
        app.fingerprintPrompt = FakeFingerprintPrompt()
        app.clock = { now }
        app.phoneStore.disconnect()
        app.settings.lockDelay = lockDelay
        app.phoneStore.createVault(masterPassword)
        app.phoneStore.lock()
        app.pendingSave.put(SaveData(AppRequest("com.example.bank", null, null), "jan", "nowe-haslo"))
        beforeLaunch()
        scenario = ActivityScenario.launchActivityForResult(Intent(app, AutofillSaveActivity::class.java))
    }

    /** Runs with the candidate in place, before the activity starts. */
    protected open fun beforeLaunch() {}

    protected fun age(ms: Long) { now += ms }

    @After
    fun stop() {
        scenario.close()
        app.leaveLock.cancel()
        app.pendingSave.clear()
        app.clock = System::currentTimeMillis
    }

    protected fun type(label: String, text: String) =
        compose.onNode(hasSetTextAction() and hasText(label)).performTextReplacement(text)

    protected fun click(text: String) = compose.onNodeWithText(text).performClick()

    protected fun waitFor(text: String) =
        compose.waitUntil(30_000) { compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty() }

    protected fun waitForResult(): Instrumentation.ActivityResult {
        compose.waitUntil(30_000) { finishing() }
        return scenario.result
    }

    protected fun finishing(): Boolean {
        if (scenario.state == Lifecycle.State.DESTROYED) return true
        var finishing = false
        scenario.onActivity { finishing = it.isFinishing }
        return finishing
    }

    /** Logins in the vault, read after unlocking it for the check (the vault is locked again by then). */
    protected fun logins(): List<LoginFields> {
        app.phoneStore.unlock(masterPassword)
        return try {
            app.phoneStore.entries().mapNotNull { it.content.fields as? LoginFields }
        } finally {
            app.phoneStore.lock()
        }
    }
}

class AutofillSavePasswordTest : AutofillSaveTestBase() {
    @Test
    fun `the master password saves the login and locks the vault again at once`() {
        waitFor("Hasło główne")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        val result = waitForResult()
        assertEquals(Activity.RESULT_OK, result.resultCode)
        assertNull(result.resultData)
        assertFalse(app.phoneStore.isUnlocked)
        assertNull(app.pendingSave.take())
        val saved = logins().single()
        assertEquals("jan", saved.username)
        assertEquals("nowe-haslo", saved.password)
        assertEquals(listOf("com.example.bank"), saved.androidApps)
    }
}

class AutofillSaveDelayTest : AutofillSaveTestBase() {
    override val lockDelay = true

    @Test
    fun `with the lock delay on the vault stays open for 60 s after saving`() {
        waitFor("Hasło główne")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertTrue("the 60 s delay keeps the vault open", app.phoneStore.isUnlocked)
        assertEquals("nowe-haslo", (app.phoneStore.entries().single().content.fields as LoginFields).password)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(LeaveLock.DELAY_MS + 1_000))
        val deadline = System.currentTimeMillis() + 10_000
        while (app.phoneStore.isUnlocked && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertFalse(app.phoneStore.isUnlocked)
    }
}

class AutofillSaveCancelTest : AutofillSaveTestBase() {
    @Test
    fun `Anuluj drops the candidate and saves nothing`() {
        waitFor("Anuluj")
        click("Anuluj")
        assertEquals(Activity.RESULT_CANCELED, waitForResult().resultCode)
        assertNull(app.pendingSave.take())
        assertTrue(logins().isEmpty())
    }
}

class AutofillSaveExpiredTest : AutofillSaveTestBase() {
    @Test
    fun `a candidate that expired while the screen was open saves nothing`() {
        waitFor("Hasło główne")
        age(120_001)
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertFalse(app.phoneStore.isUnlocked)
        assertTrue(logins().isEmpty())
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("Minęły 2 minuty – zaloguj się ponownie, aby zapisać", org.robolectric.shadows.ShadowToast.getTextOfLatestToast())
    }
}

class AutofillSaveNoCandidateTest : AutofillSaveTestBase() {
    override fun beforeLaunch() = app.pendingSave.clear()

    @Test
    fun `without a candidate the screen closes at once`() {
        assertTrue(finishing())
        assertEquals(Activity.RESULT_CANCELED, scenario.result.resultCode)
    }
}

class AutofillSaveBackTest : AutofillSaveTestBase() {
    @Test
    fun `Back drops the candidate and saves nothing`() {
        waitFor("Anuluj")
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        assertEquals(Activity.RESULT_CANCELED, waitForResult().resultCode)
        assertNull(app.pendingSave.take())
        assertTrue(logins().isEmpty())
    }
}

/** An earlier delayed lock fired and left its deadline behind; that must not make the save see a locked vault. */
class AutofillSaveStaleDeadlineTest : AutofillSaveTestBase() {
    override fun beforeLaunch() {
        app.leaveLock = LeaveLock(app.phoneStore, now = { now() })
        app.leaveLock.schedule(LeaveLock.DELAY_MS)
        stale = true
    }
    private var stale = false
    private fun now() = if (stale) 1_000_000_000L else 0L

    @Test
    fun `a stale leave-lock deadline does not lose the save`() {
        waitFor("Hasło główne")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertEquals("nowe-haslo", logins().single().password)
    }
}
