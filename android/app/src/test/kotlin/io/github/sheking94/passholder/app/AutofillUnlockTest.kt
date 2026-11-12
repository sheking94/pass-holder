package io.github.sheking94.passholder.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Looper
import android.service.autofill.FillResponse
import android.view.WindowManager
import android.view.autofill.AutofillManager
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
import io.github.sheking94.passholder.app.autofill.AutofillUnlockActivity
import io.github.sheking94.passholder.app.autofill.ParsedRequest
import io.github.sheking94.passholder.app.autofill.autofillId
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.AutofillNode
import io.github.sheking94.passholder.core.autofill.FieldDescriptor
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.After
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The unlock screen of the "Odblokuj PassHolder" suggestion, started like the system starts it. The fill request
 * comes from the [PassHolderApp.autofillRequest] hook (Robolectric cannot build an AssistStructure): one password
 * field of the app com.example.bank, and the vault has a login tied to that app.
 * One test per class (Compose test roots leak between tests in one JVM).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
abstract class AutofillUnlockTestBase {
    @get:Rule
    val compose = createEmptyComposeRule()
    protected lateinit var scenario: ActivityScenario<AutofillUnlockActivity>
    protected val app: PassHolderApp = ApplicationProvider.getApplicationContext()
    protected val keys = SoftwareKeyProtector()
    protected val finger = FakeFingerprintPrompt()
    protected val masterPassword = "Zażółć gęślą jaźń 2026"
    protected open val lockDelay = false
    protected open val request: ParsedRequest? = ParsedRequest(
        AppRequest("com.example.bank", null, null),
        listOf(AutofillNode(autofillId(2), FieldDescriptor(type = "password", name = "password"), false)),
    )

    @Before
    fun start() {
        app.secretWrapper = TestSecretWrapper
        app.biometric = BiometricUnlock(app, keys)
        app.fingerprintPrompt = finger
        app.phoneStore.disconnect()
        app.settings.lockDelay = lockDelay
        app.phoneStore.createVault(masterPassword)
        app.phoneStore.upsertContent(
            "1", EntryContentV3("Bank", "", LoginFields("jan.kowalski", "s3cret-haslo", androidApps = listOf("com.example.bank")), emptyList()),
        )
        beforeLaunch()
        app.phoneStore.lock()
        val request = request
        app.autofillRequest = { request }
        scenario = ActivityScenario.launchActivityForResult(Intent(app, AutofillUnlockActivity::class.java))
    }

    /** Runs with the vault still unlocked, before the activity starts. */
    protected open fun beforeLaunch() {}

    @After
    fun stop() {
        scenario.close()
        app.leaveLock.cancel()
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

    /** finish() was called (Robolectric may not have destroyed the activity yet). */
    protected fun finishing(): Boolean {
        if (scenario.state == Lifecycle.State.DESTROYED) return true
        var finishing = false
        scenario.onActivity { finishing = it.isFinishing }
        return finishing
    }

    protected fun Instrumentation.ActivityResult.response(): FillResponse? =
        resultData?.getParcelableExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, FillResponse::class.java)
}

class AutofillUnlockPasswordTest : AutofillUnlockTestBase() {
    @Test
    fun `a wrong password stays on the screen, the right one returns the suggestions and locks again`() {
        waitFor("Odblokuj PassHolder")
        type("Hasło główne", "zle haslo glowne")
        click("Odblokuj")
        waitFor("Złe hasło główne")
        assertEquals(Lifecycle.State.RESUMED, scenario.state)
        assertFalse(app.phoneStore.isUnlocked)

        type("Hasło główne", masterPassword)
        click("Odblokuj")
        val result = waitForResult()
        assertEquals(Activity.RESULT_OK, result.resultCode)
        assertNotNull(result.response())
        // D1: with the lock delay off, the vault locks as soon as the suggestions are handed over.
        assertFalse(app.phoneStore.isUnlocked)
    }
}

class AutofillUnlockCancelTest : AutofillUnlockTestBase() {
    @Test
    fun `Back gives no result and leaves the vault locked`() {
        waitFor("Odblokuj PassHolder")
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        val result = waitForResult()
        assertEquals(Activity.RESULT_CANCELED, result.resultCode)
        assertNull(result.response())
        assertFalse(app.phoneStore.isUnlocked)
    }
}

class AutofillUnlockCancelButtonTest : AutofillUnlockTestBase() {
    @Test
    fun `Anuluj gives no result`() {
        waitFor("Anuluj")
        click("Anuluj")
        assertEquals(Activity.RESULT_CANCELED, waitForResult().resultCode)
        assertFalse(app.phoneStore.isUnlocked)
    }
}

/** Fingerprint on: the dialog opens by itself; with the lock delay on, the vault stays open for 60 s (D1). */
class AutofillUnlockFingerprintTest : AutofillUnlockTestBase() {
    override val lockDelay = true

    override fun beforeLaunch() {
        val cipher = app.biometric.cipherToEnable()
        app.biometric.enable(cipher, app.phoneStore.exportUnlockKeys())
    }

    @Test
    fun `the fingerprint dialog opens by itself and unlocks`() {
        val result = waitForResult()
        assertEquals(1, finger.shown)
        assertEquals(Activity.RESULT_OK, result.resultCode)
        assertNotNull(result.response())
        assertTrue("the 60 s delay keeps the vault open", app.phoneStore.isUnlocked)
        // D1 with the delay on: the vault locks once the 60 s run out (the lock task runs on its own thread).
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(LeaveLock.DELAY_MS + 1_000))
        val deadline = System.currentTimeMillis() + 10_000
        while (app.phoneStore.isUnlocked && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertFalse("the vault locks 60 s after the autofill unlock", app.phoneStore.isUnlocked)
    }
}

/** No login the vault can fill: RESULT_OK with the save request only, no suggestions, and the vault locks again. */
class AutofillUnlockNoMatchTest : AutofillUnlockTestBase() {
    override val request = ParsedRequest(
        AppRequest("com.example.other", null, null),
        listOf(AutofillNode(autofillId(2), FieldDescriptor(type = "password", name = "password"), false)),
    )

    @Test
    fun `no matching login returns OK with save info and no datasets`() {
        waitFor("Hasło główne")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        val result = waitForResult()
        assertEquals(Activity.RESULT_OK, result.resultCode)
        val response = result.response()!!
        assertNull(response.javaClass.getMethod("getDatasets").invoke(response))
        assertNotNull(response.javaClass.getMethod("getSaveInfo").invoke(response))
        assertFalse(app.phoneStore.isUnlocked)
    }
}

class AutofillUnlockSecureTest : AutofillUnlockTestBase() {
    @Test
    fun `the unlock screen blocks screenshots`() {
        waitFor("Odblokuj PassHolder")
        scenario.onActivity {
            assertTrue((it.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0)
        }
    }
}

/** Started without a fill request (no assist structure): cancelled at once. */
class AutofillUnlockNoRequestTest : AutofillUnlockTestBase() {
    override val request: ParsedRequest? = null

    @Test
    fun `no request cancels at once`() {
        assertTrue(finishing())
        assertEquals(Activity.RESULT_CANCELED, scenario.result.resultCode)
        assertFalse(app.phoneStore.isUnlocked)
    }
}

/**
 * Review Focus 4: MainActivity sits locked in the background, the vault is unlocked from an autofill suggestion
 * (with the 60 s delay on it stays open), and the user opens the app: the list, not the locked screen.
 */
class ReturnAfterAutofillUnlockTest : ScreenTestBase() {
    @Test
    fun `the locked screen shows the list when the vault was unlocked meanwhile`() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        app.settings.lockDelay = true
        createVault()
        addEntry("bank.pl", "jan.kowalski", "s3cret-haslo")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        menu("Zablokuj")
        waitFor("PassHolder jest zablokowany")

        scenario.moveToState(Lifecycle.State.CREATED)
        app.phoneStore.unlock(masterPassword)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("bank.pl")
        assertEquals(Screen.List, viewModel().state.value.screen)
        app.leaveLock.cancel()
    }
}
