package io.github.sheking94.passholder.app

import android.content.ClipboardManager
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.printToLog
import androidx.compose.ui.test.printToString
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.testing.WorkManagerTestInitHelper
import com.github.takahirom.roborazzi.captureRoboImage
import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.RemoteRecord
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.FileSyncStore
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import io.github.sheking94.passholder.core.p2p.SecretWrapper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Robolectric has no Android Keystore: the phone's identity key is wrapped with a plain software AES key,
 * in the same format as [KeystoreSecretWrapper].
 */
object TestSecretWrapper : SecretWrapper {
    private val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")

    override fun wrap(secret: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        val ct = cipher.doFinal(secret)
        return Base64.getEncoder().encodeToString(cipher.iv) + ":" + Base64.getEncoder().encodeToString(ct)
    }

    override fun unwrap(wrapped: String): ByteArray {
        val (iv, ct) = wrapped.split(":").map { Base64.getDecoder().decode(it) }
        return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }.doFinal(ct)
    }
}

/**
 * The real app (MainActivity, ViewModel, PhoneVaultStore, Compose) on the JVM through Robolectric. Tests click
 * through the app like a user and save screenshots to app/screenshots/.
 * One test per class: Compose test roots leak between tests in one JVM, and Gradle forks a JVM per class.
 * Run: ./gradlew :app:testDebugUnitTest
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
abstract class ScreenTestBase {
    @get:Rule
    val compose = createEmptyComposeRule()
    protected lateinit var scenario: ActivityScenario<MainActivity>

    protected val masterPassword = "Zażółć gęślą jaźń 2026"

    /** WorkManager in test mode: clipboard-clearing jobs are queued, not run on a timer. */
    @Before
    fun start() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        WorkManagerTestInitHelper.initializeTestWorkManager(app)
        app.secretWrapper = TestSecretWrapper
        // Removing the vault also deletes the fingerprint key, which needs a key protector without the Keystore.
        app.biometric = BiometricUnlock(app, SoftwareKeyProtector())
        app.syncPort = 0
        app.phoneStore.disconnect() // a fresh phone: no vault, nothing on disk
        beforeLaunch(app)
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    /** Runs before the activity starts, e.g. to put in a fake fingerprint reader. */
    protected open fun beforeLaunch(app: PassHolderApp) {}

    @After
    fun stop() {
        scenario.close()
    }

    protected fun shot(name: String) {
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("screenshots/$name.png")
    }

    protected fun field(label: String) = compose.onNode(hasSetTextAction() and hasText(label))

    protected fun type(label: String, text: String) = field(label).performTextReplacement(text)

    /** Clicks the node with exactly [text], scrolled into view first when it sits in a scrolling form. */
    protected fun click(text: String) {
        val node = compose.onNodeWithText(text)
        runCatching { node.performScrollTo() }
        node.performClick()
    }

    /** The button [button] ("Pokaż", "Kopiuj"…) inside the [index]-th text field labelled [fieldLabel]. */
    protected fun fieldButton(fieldLabel: String, button: String, index: Int = 0) =
        compose.onAllNodes(hasText(button) and hasAnyAncestor(hasSetTextAction() and hasText(fieldLabel)))[index]

    /** The text in the [index]-th text field labelled [label]. */
    protected fun editable(label: String, index: Int = 0): String =
        compose.onAllNodes(hasSetTextAction() and hasText(label))[index].fetchSemanticsNode()
            .config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text

    /** Opens ⋮ in the list's top bar and picks [item]. */
    protected fun menu(item: String) {
        compose.onNodeWithContentDescription("Więcej").performClick()
        waitFor(item)
        click(item)
    }

    protected fun viewModel(): AppViewModel {
        lateinit var vm: AppViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[AppViewModel::class.java] }
        return vm
    }

    protected fun waitFor(text: String, substring: Boolean = false) {
        try {
            compose.waitUntil(30_000) { compose.onAllNodes(hasText(text, substring = substring)).fetchSemanticsNodes().isNotEmpty() }
        } catch (e: Throwable) {
            compose.onRoot().printToLog("WAITFOR")
            println(compose.onRoot(useUnmergedTree = true).printToString())
            throw e
        }
    }

    protected fun gone(text: String) = compose.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isEmpty()

    /** "Nowy sejf" on the start screen, up to the empty list. */
    protected fun createVault() {
        waitFor("Załóż sejf")
        type("Hasło główne", masterPassword)
        type("Powtórz hasło główne", masterPassword)
        click("Załóż sejf")
        waitFor("Brak wpisów. Dodaj pierwszy.")
    }

    /** Writes an entry of any type straight into the store and refreshes the list. */
    protected fun putEntry(content: EntryContentV3): String {
        val id = java.util.UUID.randomUUID().toString()
        ApplicationProvider.getApplicationContext<PassHolderApp>().phoneStore.upsertContent(id, content)
        viewModel().reloadEntries()
        compose.waitForIdle()
        return id
    }

    protected fun addEntry(name: String, login: String, password: String?) {
        click("+ Dodaj")
        waitFor("Nowy login")
        type("Nazwa", name)
        type("Login", login)
        if (password != null) type("Hasło", password) else click("Generuj")
    }

    protected fun lockAndUnlock() {
        menu("Zablokuj")
        waitFor("PassHolder jest zablokowany")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
    }
}

class FullFlowScreensTest : ScreenTestBase() {
    @Test
    fun `new vault, entries, copy, delete, lock and unlock`() {
        waitFor("Załóż sejf")
        shot("01-start-nowy-sejf")

        // The same rules as the extension: at least 12 characters, typed twice the same.
        type("Hasło główne", "za krotkie")
        type("Powtórz hasło główne", "za krotkie")
        click("Załóż sejf")
        waitFor("Hasło główne musi mieć co najmniej 12 znaków")
        shot("02-start-za-krotkie-haslo")
        type("Hasło główne", masterPassword)
        type("Powtórz hasło główne", "$masterPassword!")
        click("Załóż sejf")
        waitFor("Hasła się różnią")

        createVault()
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        assertTrue(app.phoneStore.hasVault)
        shot("03-pusty-sejf")

        addEntry("bank.pl", "jan.kowalski", null)
        val generated = field("Hasło").fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text
        assertEquals(20, generated.length)
        shot("04-nowy-wpis-z-generatorem")
        click("Zapisz")
        waitFor("Zapisano na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji.")

        addEntry("poczta.onet.pl", "jan@onet.pl", "hunter2-ale-dluzsze")
        click("Zapisz")
        // Not the entry's name: the edit form shows it too.
        waitFor("Zapisano na telefonie", substring = true)
        shot("05-lista")
        // On disk only ciphertext.
        val records = File(app.filesDir, "p2p/records.jsonl").readText()
        assertEquals(2, records.lines().count { it.isNotBlank() })
        assertFalse(records.contains("bank.pl") || records.contains("jan.kowalski"))

        compose.onAllNodes(hasText("Hasło") and SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsActions.OnClick))[0].performClick()
        waitFor("Skopiowano hasło", substring = true)
        val clipboard = app.getSystemService(ClipboardManager::class.java)
        assertEquals(generated, clipboard.primaryClip!!.getItemAt(0).text.toString())
        shot("06-skopiowane-haslo")

        click("poczta.onet.pl")
        waitFor("Edytuj login")
        click("Usuń")
        waitFor("Usunąć wpis?")
        shot("07-usuwanie")
        compose.onAllNodes(hasText("Usuń"))[1].performClick()
        waitFor("Usunięto na telefonie. Wtyczka dostanie zmianę przy następnej synchronizacji.")

        click("Synchronizacja")
        waitFor("Czekam na wtyczkę…")
        click("Zakończ")

        lockAndUnlock()
        waitFor("bank.pl")
        assertTrue(gone("poczta.onet.pl"))
        shot("08-po-odblokowaniu")
    }
}

class WrongPasswordTest : ScreenTestBase() {
    @Test
    fun `a wrong master password on the locked screen shows the error`() {
        createVault()
        menu("Zablokuj")
        waitFor("PassHolder jest zablokowany")
        type("Hasło główne", "zle haslo glowne")
        click("Odblokuj")
        waitFor("Złe hasło główne")
        assertFalse(ApplicationProvider.getApplicationContext<PassHolderApp>().phoneStore.isUnlocked)
        shot("09-blokada-zle-haslo")
    }
}

class StartRestoreTest : ScreenTestBase() {
    @Test
    fun `restore from the extension starts the restore and survives reopening the app`() {
        click("Odtwórz z wtyczki")
        waitFor("Rozpocznij odtwarzanie")
        shot("10-start-odtworz-z-wtyczki")
        click("Rozpocznij odtwarzanie")
        waitFor("Odtwarzanie z wtyczki")
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        assertTrue(app.phoneStore.restoreInProgress)
        assertFalse(app.phoneStore.hasVault)

        scenario.close()
        scenario = ActivityScenario.launch(MainActivity::class.java)
        waitFor("Odtwarzanie z wtyczki")
    }
}

class RemoveVaultTest : ScreenTestBase() {
    @Test
    fun `Usuń sejf z telefonu asks first, then deletes the vault and goes back to the start`() {
        createVault()
        addEntry("bank.pl", "jan.kowalski", "s3cret-haslo")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        menu("Zablokuj")
        waitFor("Usuń sejf z telefonu")
        click("Usuń sejf z telefonu")
        waitFor("Usunąć sejf z tego telefonu? Wpisy zostaną tylko na sparowanych wtyczkach.")
        shot("11-usuwanie-sejfu")
        click("Anuluj")
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        assertTrue(app.phoneStore.hasVault)

        click("Usuń sejf z telefonu")
        waitFor("Usunąć sejf z tego telefonu?", substring = true)
        click("Usuń")
        waitFor("Załóż sejf")
        assertFalse(app.phoneStore.hasVault)
        assertFalse(File(app.filesDir, "p2p").exists())
    }
}

class RemoveVaultKeystoreFailureTest : ScreenTestBase() {
    /** A Keystore that refuses to delete the fingerprint key. */
    override fun beforeLaunch(app: PassHolderApp) {
        app.biometric = BiometricUnlock(app, object : UnlockKeyProtector by SoftwareKeyProtector() {
            override fun deleteKey() = throw IllegalStateException("Keystore niedostępny")
        })
    }

    @Test
    fun `a failing fingerprint key deletion still ends on the start screen`() {
        createVault()
        menu("Zablokuj")
        waitFor("Usuń sejf z telefonu")
        click("Usuń sejf z telefonu")
        waitFor("Usunąć sejf z tego telefonu?", substring = true)
        click("Usuń")
        waitFor("Załóż sejf")
        waitFor("nie udało się usunąć klucza odcisku palca", substring = true)
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        assertFalse(app.phoneStore.hasVault)
        assertFalse(app.biometric.isEnabled)
    }
}

class UnreadableEntriesTest : ScreenTestBase() {
    /** A vault with one entry and one record the vault key cannot open (as if an extension of another vault sent it). */
    override fun beforeLaunch(app: PassHolderApp) {
        PhoneVaultStore(app.filesDir, TestSecretWrapper).apply {
            createVault(masterPassword)
            upsert("1", Credentials("github.com", "jkowalski", "s3cret"))
            lock()
        }
        FileSyncStore(File(app.filesDir, "p2p/records.jsonl")).apply {
            put(RemoteRecord("obcy", currentRevision() + 1, false, "bm90IGEgcmVhbCBibG9i"))
        }
        // The app's store read the (then empty) disk at start; a new one sees the vault.
        app.replacePhoneStore(PhoneVaultStore(app.filesDir, TestSecretWrapper))
    }

    @Test
    fun `the list warns about records the vault key cannot open`() {
        waitFor("PassHolder jest zablokowany")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        waitFor("github.com")
        waitFor("Wpisów nie do odczytania: 1", substring = true)
        shot("12-nieczytelne-wpisy")
    }
}

class CorruptHostStateTest : ScreenTestBase() {
    /** host.json damaged on disk; the store the app builds at start must not throw (it did, on every launch). */
    override fun beforeLaunch(app: PassHolderApp) {
        File(app.filesDir, "p2p").mkdirs()
        File(app.filesDir, "p2p/host.json").writeText("{\"deviceId\": tru")
        app.replacePhoneStore(PhoneVaultStore(app.filesDir, TestSecretWrapper))
    }

    @Test
    fun `a damaged host json shows the start screen with the error and the vault can be removed`() {
        waitFor(
            "Nie mogę odczytać danych sejfu na telefonie. Możesz je usunąć i założyć sejf od nowa albo odtworzyć go z wtyczki.",
        )
        shot("29-uszkodzony-sejf")
        click("Usuń sejf z telefonu")
        waitFor("Usunąć sejf z tego telefonu? Wpisy zostaną tylko na sparowanych wtyczkach.")
        compose.onAllNodes(hasText("Usuń"))[0].performClick()
        waitFor("Załóż sejf")
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        assertFalse(app.phoneStore.corruptState)
        assertFalse(File(app.filesDir, "p2p").exists())
        assertTrue(gone("Nie mogę odczytać"))
        createVault()
    }
}
