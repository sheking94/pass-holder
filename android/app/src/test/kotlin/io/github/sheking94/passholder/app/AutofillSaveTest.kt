package io.github.sheking94.passholder.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.test.assertIsNotEnabled
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
import org.robolectric.shadows.ShadowToast
import java.time.Duration

/**
 * Saving a submitted login through the review screen: the service left a candidate in [PassHolderApp.pendingSave],
 * the system starts this screen; the vault is locked unless [unlockedAtStart]. One test per class (Compose test
 * roots leak between tests in one JVM).
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
    protected open val unlockedAtStart = false
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
        if (!unlockedAtStart) app.phoneStore.lock()
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

    protected fun unlock() {
        waitFor("Hasło główne")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        waitFor("Zapisz w PassHolder")
    }

    protected fun latestToast(): String? {
        shadowOf(Looper.getMainLooper()).idle()
        return ShadowToast.getTextOfLatestToast()
    }

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

    /** Logins in the vault, read after unlocking it for the check if it is locked (and locked again then). */
    protected fun logins(): List<LoginFields> {
        if (app.phoneStore.isUnlocked) return app.phoneStore.entries().mapNotNull { it.content.fields as? LoginFields }
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
    fun `the master password opens the review, Zapisz saves and locks the vault again at once`() {
        unlock()
        compose.onNodeWithText("Nowy login").assertExists()
        compose.onNodeWithText("Aplikacja: com.example.bank").assertExists()
        assertTrue("open while the review is shown", app.phoneStore.isUnlocked)
        click("Zapisz")
        val result = waitForResult()
        assertEquals(Activity.RESULT_OK, result.resultCode)
        assertNull(result.resultData)
        assertFalse(app.phoneStore.isUnlocked)
        assertNull(app.pendingSave.take())
        val saved = logins().single()
        assertEquals("jan", saved.username)
        assertEquals("nowe-haslo", saved.password)
        assertEquals(listOf("com.example.bank"), saved.androidApps)
        assertEquals("Zapisano w PassHolder", latestToast())
    }
}

class AutofillSaveDelayTest : AutofillSaveTestBase() {
    override val lockDelay = true

    @Test
    fun `with the lock delay on the vault stays open for 60 s after saving`() {
        unlock()
        click("Zapisz")
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
        assertEquals("Minęły 2 minuty – zaloguj się ponownie, aby zapisać", latestToast())
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
        unlock()
        click("Zapisz")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertEquals("nowe-haslo", logins().single().password)
    }
}

class AutofillSaveReviewUnlockedTest : AutofillSaveTestBase() {
    override val unlockedAtStart = true

    @Test
    fun `an open vault goes straight to the review, saves the edited login and stays open`() {
        waitFor("Zapisz w PassHolder")
        assertTrue(compose.onAllNodes(hasText("Hasło główne")).fetchSemanticsNodes().isEmpty())
        type("Nazwa", "Mój bank")
        type("Login", "jan.kowalski")
        type("Hasło", "poprawione")
        click("Zapisz")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertTrue("R2: the vault the app had open stays open", app.phoneStore.isUnlocked)
        val entry = app.phoneStore.entries().single()
        assertEquals("Mój bank", entry.content.name)
        val fields = entry.content.fields as LoginFields
        assertEquals("jan.kowalski", fields.username)
        assertEquals("poprawione", fields.password)
    }
}

class AutofillSaveReviewCancelTest : AutofillSaveTestBase() {
    @Test
    fun `Anuluj on the review saves nothing and locks the vault this screen opened`() {
        unlock()
        click("Anuluj")
        assertEquals(Activity.RESULT_CANCELED, waitForResult().resultCode)
        assertFalse(app.phoneStore.isUnlocked)
        assertNull(app.pendingSave.take())
        assertTrue(logins().isEmpty())
    }
}

class AutofillSaveReviewBackTest : AutofillSaveTestBase() {
    @Test
    fun `Back on the review saves nothing and locks the vault this screen opened`() {
        unlock()
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        assertEquals(Activity.RESULT_CANCELED, waitForResult().resultCode)
        assertFalse(app.phoneStore.isUnlocked)
        assertTrue(logins().isEmpty())
    }
}

class AutofillSaveReviewCancelUnlockedTest : AutofillSaveTestBase() {
    override val unlockedAtStart = true

    @Test
    fun `Anuluj on the review of an open vault leaves it open`() {
        waitFor("Zapisz w PassHolder")
        click("Anuluj")
        assertEquals(Activity.RESULT_CANCELED, waitForResult().resultCode)
        assertTrue(app.phoneStore.isUnlocked)
        assertTrue(logins().isEmpty())
    }
}

/** The submitted login is in the vault already, with the same password. */
class AutofillSaveReviewNoneTest : AutofillSaveTestBase() {
    override val unlockedAtStart = true

    override fun beforeLaunch() = app.phoneStore.upsertContent(
        "1", EntryContentV3("Bank", "", LoginFields("jan", "nowe-haslo", androidApps = listOf("com.example.bank")), emptyList()),
    )

    @Test
    fun `a login saved already closes the screen with a Toast`() {
        compose.waitUntil(30_000) { finishing() }
        assertEquals("Ten login jest już zapisany w PassHolder", latestToast())
        assertEquals(1, logins().size)
        assertNull(app.pendingSave.take())
    }
}

/** Editing the login into one the vault has with the same password: nothing to save. */
class AutofillSaveReviewSameLoginTest : AutofillSaveTestBase() {
    override val unlockedAtStart = true

    override fun beforeLaunch() = app.phoneStore.upsertContent(
        "1", EntryContentV3("Bank", "", LoginFields("anna", "nowe-haslo", androidApps = listOf("com.example.bank")), emptyList()),
    )

    @Test
    fun `the header follows the edits and Zapisz turns off for a saved login`() {
        waitFor("Nowy login")
        type("Login", "anna")
        waitFor("Ten login jest już zapisany")
        compose.onNodeWithText("Zapisz").assertIsNotEnabled()
        compose.onNodeWithText("Nazwa").assertDoesNotExist()
        type("Hasło", "inne")
        waitFor("Zmiana hasła: Bank")
        type("Hasło", "")
        compose.onNodeWithText("Zapisz").assertIsNotEnabled()
    }
}

class AutofillSaveReviewRotationTest : AutofillSaveTestBase() {
    @Test
    fun `the review and its edits survive a rotation and the vault locks when it ends`() {
        unlock()
        type("Login", "jan.kowalski")
        scenario.recreate()
        waitFor("Zapisz w PassHolder")
        assertTrue(compose.onAllNodes(hasText("Hasło główne")).fetchSemanticsNodes().isEmpty())
        assertTrue(app.phoneStore.isUnlocked)
        click("Zapisz")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertFalse(app.phoneStore.isUnlocked)
        assertEquals("jan.kowalski", logins().single().username)
    }
}

/** The app's own delayed lock fires while the review of a vault it had open is on screen. */
class AutofillSaveReviewLeaveLockTest : AutofillSaveTestBase() {
    override val unlockedAtStart = true

    override fun beforeLaunch() {
        app.leaveLock = LeaveLock(app.phoneStore, now = { 0L })
        app.leaveLock.schedule(LeaveLock.DELAY_MS)
    }

    @Test
    fun `a vault locked during the review asks to unlock and keeps the edited draft`() {
        waitFor("Zapisz w PassHolder")
        type("Login", "jan.kowalski")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(LeaveLock.DELAY_MS + 1_000))
        val deadline = System.currentTimeMillis() + 10_000
        while (app.phoneStore.isUnlocked && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertFalse(app.phoneStore.isUnlocked)
        click("Zapisz")
        unlock()
        compose.onNode(hasSetTextAction() and hasText("jan.kowalski")).assertExists()
        click("Zapisz")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertFalse("this screen unlocked it, so it locks it again", app.phoneStore.isUnlocked)
        assertEquals("jan.kowalski", logins().single().username)
    }
}

class AutofillSaveReviewBackgroundTest : AutofillSaveTestBase() {
    @Test
    fun `a review left in the background locks the vault and asks again on return`() {
        unlock()
        type("Login", "jan.kowalski")
        scenario.moveToState(Lifecycle.State.CREATED)
        assertFalse("D1 with the delay off: locked at once", app.phoneStore.isUnlocked)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("PassHolder się zablokował – odblokuj ponownie")
        unlock()
        compose.onNode(hasSetTextAction() and hasText("jan.kowalski")).assertExists()
        click("Zapisz")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertFalse(app.phoneStore.isUnlocked)
        assertEquals("jan.kowalski", logins().single().username)
    }
}

/** The same login arrives (a sync) while the review is open. */
class AutofillSaveReviewFreshEntriesTest : AutofillSaveTestBase() {
    override val unlockedAtStart = true

    @Test
    fun `Zapisz decides on the vault as it is then`() {
        waitFor("Nowy login")
        app.phoneStore.upsertContent(
            "1", EntryContentV3("Bank", "", LoginFields("jan", "nowe-haslo", androidApps = listOf("com.example.bank")), emptyList()),
        )
        click("Zapisz")
        assertEquals(Activity.RESULT_OK, waitForResult().resultCode)
        assertEquals("Ten login jest już zapisany w PassHolder", latestToast())
        assertEquals(1, logins().size)
    }
}
