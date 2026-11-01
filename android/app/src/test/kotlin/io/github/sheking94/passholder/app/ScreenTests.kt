package io.github.sheking94.passholder.app

import android.content.ClipboardManager
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.printToLog
import androidx.compose.ui.test.printToString
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import io.github.sheking94.passholder.core.FakeServer
import io.github.sheking94.passholder.core.Credentials
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Before
import org.junit.Test
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The real app (MainActivity, ViewModel, VaultStore, Compose) on the JVM through Robolectric, against a fake
 * server over HTTPS. Tests click through the app like a user and save screenshots to app/screenshots/.
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
    protected val ca = HeldCertificate.Builder().certificateAuthority(0).commonName("PassHolder local CA").build()
    protected val serverCert = HeldCertificate.Builder().signedBy(ca).commonName("passholder.local").build()
    protected val fake = FakeServer(setupToken = "3f9c2a7e5b1d")
    protected val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(serverCert, ca.certificate).build().sslSocketFactory(), false)
        dispatcher = fake
        start()
    }
    protected val url = "https://127.0.0.1:${server.port}"

    /** WorkManager in test mode: clipboard-clearing jobs are queued, not run on a timer. */
    @Before
    fun start() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        WorkManagerTestInitHelper.initializeTestWorkManager(app)
        app.vaultStore.disconnect() // a fresh phone: no account, nothing on disk
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    @After
    fun stop() {
        scenario.close()
        server.shutdown()
    }

    protected fun shot(name: String) {
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("screenshots/$name.png")
    }

    protected fun field(label: String) = compose.onNode(hasSetTextAction() and hasText(label))

    protected fun type(label: String, text: String) = field(label).performTextReplacement(text)

    protected fun click(text: String) = compose.onNodeWithText(text).performClick()

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

    protected fun createVault() {
        click("Nowy sejf")
        type("Adres serwera, np. https://passholder.local:8443", url)
        click("Dalej: sprawdź certyfikat")
        waitFor("Odcisk się zgadza")
    }

    protected fun finishCreate() {
        click("Odcisk się zgadza")
        type("Token z logu serwera (jednorazowy)", "3f9c2a7e5b1d")
        type("Hasło główne", masterPassword)
        type("Powtórz hasło główne", masterPassword)
        click("Załóż sejf")
        waitFor("Brak wpisów. Dodaj pierwszy.")
    }

    protected fun addEntry(name: String, login: String, password: String?) {
        click("+ Dodaj")
        type("Nazwa serwisu", name)
        type("Login", login)
        if (password != null) type("Hasło", password) else click("Generuj")
    }
}

class FullFlowScreensTest : ScreenTestBase() {
    @Test
    fun `full flow with a screenshot of every screen`() {
        shot("01-polaczenie")

        createVault()
        // The fingerprint the app shows is the SHA-256 of exactly the certificate the server presents.
        val fingerprint = io.github.sheking94.passholder.core.CertificatePin.fingerprint(serverCert.certificate)
        compose.onNodeWithText(fingerprint.split(":").chunked(8).joinToString("\n") { it.joinToString(":") }).assertExists()
        // Nothing can be sent before the fingerprint is confirmed.
        compose.onNodeWithText("Załóż sejf").assertIsNotEnabled()
        shot("02-odcisk-certyfikatu")

        finishCreate()
        shot("03-pusty-sejf")

        addEntry("bank.pl", "jan.kowalski", null)
        val generated = field("Hasło").fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text
        assertEquals(20, generated.length)
        shot("04-nowy-wpis-z-generatorem")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)

        addEntry("poczta.onet.pl", "jan@onet.pl", "hunter2-ale-dluzsze")
        click("Zapisz")
        waitFor("poczta.onet.pl •")
        shot("05-lista-niezsynchronizowane")

        click("Synchronizuj")
        waitFor("Zsynchronizowano", substring = true)
        assertTrue(gone("•"))
        assertEquals(2, fake.sync.records.size)
        // The server got only ciphertext.
        assertFalse(fake.sync.records.values.joinToString().contains("bank.pl"))
        shot("06-po-synchronizacji")

        compose.onAllNodes(hasText("Hasło") and SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsActions.OnClick))[0].performClick()
        waitFor("Skopiowano hasło", substring = true)
        val clipboard = ApplicationProvider.getApplicationContext<PassHolderApp>().getSystemService(ClipboardManager::class.java)
        assertEquals(generated, clipboard.primaryClip!!.getItemAt(0).text.toString())
        shot("07-skopiowane-haslo")

        click("bank.pl")
        waitFor("Edytuj wpis")
        click("Usuń")
        waitFor("Usunąć wpis?")
        shot("08-usuwanie")
        compose.onAllNodes(hasText("Usuń"))[1].performClick()
        waitFor("Usunięto na telefonie", substring = true)

        click("Zablokuj")
        waitFor("PassHolder jest zablokowany")
        type("Hasło główne", "zle haslo")
        click("Odblokuj")
        waitFor("Złe hasło główne")
        shot("09-blokada-zle-haslo")

        type("Hasło główne", masterPassword)
        click("Odblokuj")
        waitFor("poczta.onet.pl")
        assertTrue(gone("bank.pl •") && gone("jan.kowalski"))
    }
}

class PairingErrorsTest : ScreenTestBase() {
    @Test
    fun `pairing with a wrong setup token and with an unreachable server shows the error`() {
        type("Adres serwera, np. https://passholder.local:8443", "https://127.0.0.1:1")
        click("Dalej: sprawdź certyfikat")
        waitFor("Serwer jest niedostępny", substring = true)

        createVault()
        click("Odcisk się zgadza")
        type("Token z logu serwera (jednorazowy)", "zly")
        type("Hasło główne", masterPassword)
        type("Powtórz hasło główne", masterPassword)
        click("Załóż sejf")
        waitFor("Zły token z logu serwera")
        shot("10-zly-token")
    }
}

class SecondPhoneTest : ScreenTestBase() {
    @Test
    fun `a second phone downloads what the first one saved`() {
        // Another device already created the vault and synced an entry.
        val other = io.github.sheking94.passholder.core.VaultStore(io.github.sheking94.passholder.core.MemoryStore())
        val pin = io.github.sheking94.passholder.core.CertificatePin.fingerprint(serverCert.certificate)
        other.createVault(url, pin, "3f9c2a7e5b1d", masterPassword)
        other.upsert("1", Credentials("github.com", "jkowalski", "s3cret"))
        other.sync()

        type("Adres serwera, np. https://passholder.local:8443", url)
        click("Dalej: sprawdź certyfikat")
        waitFor("Odcisk się zgadza")
        click("Odcisk się zgadza")
        type("Hasło główne", masterPassword)
        click("Połącz")
        waitFor("github.com")
        shot("11-drugi-telefon")
    }
}

class TwoAddressesTest : ScreenTestBase() {
    @Test
    fun `pairs with two addresses while only one answers, then edits them`() {
        // At home with the VPN off: the first address does not answer, the certificate comes from the second.
        val offline = "https://127.0.0.1:1"
        click("Nowy sejf")
        type(io.github.sheking94.passholder.app.ui.URL_LABEL, offline)
        type(io.github.sheking94.passholder.app.ui.SECOND_URL_LABEL, url)
        click("Dalej: sprawdź certyfikat")
        waitFor("Odcisk się zgadza")
        waitFor("(z adresu $url)", substring = true)
        shot("12-dwa-adresy")
        finishCreate()

        val store = ApplicationProvider.getApplicationContext<PassHolderApp>().vaultStore
        assertEquals(listOf(offline, url), store.account()!!.serverUrls)
        assertEquals(url, store.account()!!.lastServerUrl)

        click("Synchronizuj")
        waitFor("Zsynchronizowano", substring = true)

        click("Adresy")
        waitFor("Adresy serwera")
        shot("13-adresy-serwera")
        type(io.github.sheking94.passholder.app.ui.URL_LABEL, url)
        type(io.github.sheking94.passholder.app.ui.SECOND_URL_LABEL, "")
        click("Zapisz")
        waitFor("Zapisano adresy serwera", substring = true)
        assertEquals(listOf(url), store.account()!!.serverUrls)
    }
}
