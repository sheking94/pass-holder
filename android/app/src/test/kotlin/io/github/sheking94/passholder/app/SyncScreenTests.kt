package io.github.sheking94.passholder.app

import android.view.WindowManager
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import io.github.sheking94.passholder.core.ChangeRequest
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.Kdf
import io.github.sheking94.passholder.core.KdfParams
import io.github.sheking94.passholder.core.VaultCrypto
import io.github.sheking94.passholder.core.p2p.DeviceIdentity
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.EntryDataV3
import io.github.sheking94.passholder.core.p2p.EntryV3
import io.github.sheking94.passholder.core.p2p.Hlc
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.HttpTestTransport
import io.github.sheking94.passholder.core.p2p.NoiseKeys
import io.github.sheking94.passholder.core.p2p.P2pSyncRequest
import io.github.sheking94.passholder.core.p2p.PairResult
import io.github.sheking94.passholder.core.p2p.TestP2pClient
import io.github.sheking94.passholder.core.p2p.VaultInfo
import io.github.sheking94.passholder.core.p2p.credentials
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/**
 * Sync mode with a real [io.github.sheking94.passholder.core.p2p.SyncHttpServer] on a free port of the test JVM;
 * the extension is played by [TestP2pClient] over HTTP.
 */
abstract class SyncScreenTestBase : ScreenTestBase() {
    /** The port the sync server is listening on (the app asks for any free one). */
    @Volatile
    protected var port = -1
    /** The app's clock (vault store and sync mode); a fixed start keeps the dates on the screenshots the same. */
    @Volatile
    protected var clock = 1_794_000_000_000L

    protected val extKey = NoiseKeys.generate()
    protected val extIdentity = DeviceIdentity("ext-1", "test-ext", Encoding.toBase64(extKey.publicKey))

    override fun beforeLaunch(app: PassHolderApp) {
        app.clock = { clock }
        // The test host's network interfaces do not matter: one loopback address with the port actually bound.
        app.syncAddresses = { bound ->
            port = bound
            listOf("http://127.0.0.1:$bound")
        }
    }

    protected val app get() = ApplicationProvider.getApplicationContext<PassHolderApp>()

    protected fun http() = HttpTestTransport(port)

    protected fun keepsScreenOn(): Boolean {
        var on = false
        scenario.onActivity { on = it.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0 }
        return on
    }

    /** The pairing code as shown ("1234 5678"), without the space. */
    protected fun shownCode(): String {
        val pattern = Regex("""\d{4} \d{4}""")
        compose.waitUntil(30_000) { codeNodes(pattern).isNotEmpty() }
        return codeNodes(pattern).single().replace(" ", "")
    }

    protected fun loginData(name: String, username: String, password: String, hlc: Hlc) =
        EntryDataV3(EntryContentV3(name, "", LoginFields(username, password), emptyList()), hlc)

    private fun codeNodes(pattern: Regex) = compose.onAllNodes(hasText(" ", substring = true)).fetchSemanticsNodes()
        .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty().map { t -> t.text } }
        .filter { pattern.matches(it) }

    protected fun ping(): Int = http()("/p2p/v1/ping", "{}".toByteArray()).status

    protected fun assertNotListening(p: Int) {
        try {
            HttpTestTransport(p)("/p2p/v1/ping", "{}".toByteArray())
            fail("port $p still answers")
        } catch (_: IOException) {
        }
    }

    protected fun client(pair: PairResult) =
        TestP2pClient(extIdentity.deviceId, extKey, Encoding.fromBase64(pair.phoneIdentity!!.staticPublicKey), http())
}

class SyncAndPairTest : SyncScreenTestBase() {
    @Test
    fun `pair an extension with the shown code, sync, see it in Urządzenia and remove it`() {
        createVault()
        click("Synchronizacja")
        waitFor("Czekam na wtyczkę…")
        waitFor("http://127.0.0.1:$port")
        assertTrue(keepsScreenOn())
        shot("20-synchronizacja")

        click("Dodaj wtyczkę")
        waitFor("Ważny jeszcze 02:00", substring = true)
        val code = shownCode()
        assertEquals(8, code.length)
        shot("21-kod-parowania")

        val pair = TestP2pClient.pair(http(), code, extIdentity)
        assertEquals(pair.finish?.body, 200, pair.finish?.status)
        waitFor("Sparowano: test-ext")
        waitFor("Kod wygasł lub został użyty. Dodaj wtyczkę ponownie, aby dostać nowy kod.")

        client(pair).syncResponse(P2pSyncRequest(pair.phoneVaultInfo!!.epoch, 0, emptyList()))
        waitFor("Zsynchronizowano z: test-ext")
        shot("22-zsynchronizowano")

        val firstPort = port
        click("Zakończ")
        waitFor("Brak wpisów. Dodaj pierwszy.")
        assertNotListening(firstPort)
        assertFalse(keepsScreenOn())

        menu("Urządzenia")
        waitFor("test-ext")
        waitFor("Ostatnia synchronizacja:", substring = true)
        shot("23-urzadzenia")
        click("Usuń")
        waitFor("Usunąć urządzenie test-ext? Nie będzie mogło się synchronizować.")
        shot("24-usuwanie-urzadzenia")
        compose.onAllNodes(hasText("Usuń"))[1].performClick()
        waitFor("Brak sparowanych wtyczek", substring = true)
        assertTrue(app.phoneStore.devices().isEmpty())
        click("Wróć")

        // The removed extension can no longer open a session.
        click("Synchronizacja")
        waitFor("Czekam na wtyczkę…")
        waitFor("http://127.0.0.1:", substring = true)
        assertEquals(403, client(pair).handshakeReply().status)
    }
}

class IdleStopTest : SyncScreenTestBase() {
    @Test
    fun `sync mode turns off after 5 minutes without a sync, a ping does not keep it on`() {
        createVault()
        click("Synchronizacja")
        waitFor("http://127.0.0.1:", substring = true)
        val vm = viewModel()

        // A new code restarts the 5 minutes. (All the shifts together stay under the 15-minute auto-lock.)
        clock += 200_000
        click("Dodaj wtyczkę")
        waitFor("Ważny jeszcze", substring = true)
        clock += 299_000
        vm.checkAutoLock()
        compose.waitForIdle()
        // Anyone on the network can ping (security review V3-N2): it answers, but does not count as activity.
        assertEquals(200, ping())

        clock += 1_001
        vm.checkAutoLock()
        waitFor("Tryb synchronizacji wyłączony po 5 min bez synchronizacji.")
        assertNotListening(port)
        assertFalse(keepsScreenOn())
        shot("25-synchronizacja-wylaczona")
    }
}

class LeaveAppStopsSyncTest : SyncScreenTestBase() {
    @Test
    fun `leaving the app and locking the vault stop sync mode`() {
        createVault()
        click("Synchronizacja")
        waitFor("http://127.0.0.1:", substring = true)
        assertEquals(200, ping())

        scenario.moveToState(Lifecycle.State.CREATED) // onStop: Home
        assertNotListening(port)
        scenario.moveToState(Lifecycle.State.RESUMED)
        // The 60 s lock delay is on: the vault is still open and the screen says why sync stopped.
        waitFor("Tryb synchronizacji wyłączony po wyjściu z aplikacji.")
        click("Włącz ponownie")
        waitFor("Czekam na wtyczkę…")
        assertEquals(200, ping())

        viewModel().lock()
        waitFor("PassHolder jest zablokowany")
        assertNotListening(port)
    }
}

class RestoreFlowTest : SyncScreenTestBase() {
    @Test
    fun `restore from the extension, pair in restore mode, receive two entries, enter the password`() {
        click("Odtwórz z wtyczki")
        click("Rozpocznij odtwarzanie")
        // The server and the code are there at once.
        waitFor("http://127.0.0.1:", substring = true)
        val code = shownCode()
        assertTrue(keepsScreenOn())
        shot("26-odtwarzanie-kod")

        // The extension's vault: the cheapest KDF the phone accepts, its own vault key.
        val kdf = KdfParams("argon2id", Encoding.toBase64(Encoding.randomBytes(16)), Kdf.MIN_MEMORY_KIB, Kdf.MIN_ITERATIONS, Kdf.MIN_PARALLELISM)
        val vaultKey = VaultCrypto.newVaultKey()
        val info = VaultInfo(
            Encoding.toBase64(Encoding.randomBytes(16)), kdf,
            VaultCrypto.wrapVaultKey(Kdf.deriveKeys(masterPassword, kdf).encKey, vaultKey), emptyList(),
        )
        val pair = TestP2pClient.pair(http(), code, extIdentity, info)
        assertEquals(pair.finish?.body, 200, pair.finish?.status)
        waitFor("Czekam, aż wtyczka prześle sejf", substring = true)

        val changes = listOf("a" to "allegro.pl", "b" to "bank.pl").map { (id, name) ->
            ChangeRequest(id, 0, false, EntryV3.encrypt(vaultKey, id, loginData(name, "jan", "pw-$id", Hlc(clock, 0, extIdentity.deviceId))))
        }
        val res = client(pair).syncResponse(P2pSyncRequest(pair.phoneVaultInfo!!.epoch, 0, changes))
        assertEquals(2, res.accepted.size)

        waitFor("Zakończ odtwarzanie")
        shot("27-odtwarzanie-haslo")
        type("Hasło główne", "to nie jest to hasło")
        click("Zakończ odtwarzanie")
        waitFor("Złe hasło główne")
        type("Hasło główne", masterPassword)
        click("Zakończ odtwarzanie")
        waitFor("allegro.pl")
        waitFor("bank.pl")
        assertTrue(app.phoneStore.hasVault)
        assertEquals(2, app.phoneStore.entries().size)
        assertNotListening(port)
        shot("28-odtworzony-sejf")
    }
}

class AbortRestoreTest : SyncScreenTestBase() {
    @Test
    fun `Przerwij odtwarzanie goes back to the start screen`() {
        click("Odtwórz z wtyczki")
        click("Rozpocznij odtwarzanie")
        waitFor("http://127.0.0.1:", substring = true)
        shownCode()
        click("Przerwij odtwarzanie")
        waitFor("Załóż sejf")
        assertFalse(app.phoneStore.restoreInProgress)
        assertNotListening(port)
    }
}

class StartStopRaceTest : SyncScreenTestBase() {
    @Test
    fun `a stop that comes before the background start leaves no server running`() {
        createVault()
        val vm = viewModel()
        // Both on the main thread; each start runs on Dispatchers.IO.
        scenario.onActivity {
            vm.openSync()
            vm.onLeftApp()
        }
        scenario.onActivity {
            vm.openSync()
            vm.closeSync()
        }
        compose.waitForIdle()
        Thread.sleep(1_000)
        compose.waitForIdle()
        assertFalse(vm.syncState.value.running)
        // The second start leaves for Dispatchers.IO right away and may bind before closeSync runs; then closeSync
        // stops it. Either way nothing may be listening afterwards (it failed in CI when only "never bound" was allowed).
        if (port != -1) assertNotListening(port)
        assertFalse(keepsScreenOn())
    }
}

class RestoreRestartTest : SyncScreenTestBase() {
    @Test
    fun `restore keeps its spent code across a rotation and gets a new one after the idle stop`() {
        click("Odtwórz z wtyczki")
        click("Rozpocznij odtwarzanie")
        waitFor("http://127.0.0.1:", substring = true)
        val first = shownCode()

        // A rotation (onStart again) keeps the same code.
        scenario.recreate()
        assertEquals(first, shownCode())

        // A wrong code spends it; the hint stays after another onStart, no new code comes by itself.
        assertEquals(403, TestP2pClient.pair(http(), if (first == "00000000") "11111111" else "00000000", extIdentity, kdfLessInfo()).finish?.status)
        waitFor("Kod wygasł lub został użyty. Weź nowy kod.")
        scenario.recreate()
        waitFor("Kod wygasł lub został użyty. Weź nowy kod.")
        assertTrue(gone("Ważny jeszcze"))

        // The idle stop, then "Włącz ponownie" brings the server back with a fresh code.
        clock += 300_001
        viewModel().checkAutoLock()
        waitFor("Tryb synchronizacji wyłączony po 5 min bez synchronizacji.")
        assertNotListening(port)
        click("Włącz ponownie")
        waitFor("Ważny jeszcze 02:00", substring = true)
        shownCode()
        assertEquals(200, ping())
    }

    /** Any acceptable vault info: the pairing fails on the wrong code before it is opened. */
    private fun kdfLessInfo() = VaultInfo(
        Encoding.toBase64(Encoding.randomBytes(16)),
        KdfParams("argon2id", Encoding.toBase64(Encoding.randomBytes(16)), Kdf.MIN_MEMORY_KIB, Kdf.MIN_ITERATIONS, Kdf.MIN_PARALLELISM),
        "AA==", emptyList(),
    )
}

class SyncRefreshesEntriesTest : SyncScreenTestBase() {
    @Test
    fun `an entry the extension changed during sync mode shows its new values after Zakończ`() {
        createVault()
        addEntry("bank.pl", "jan", "stare-haslo-123")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        val old = app.phoneStore.entries().single()
        val vaultKey = app.phoneStore.exportUnlockKeys()

        click("Synchronizacja")
        waitFor("http://127.0.0.1:", substring = true)
        click("Dodaj wtyczkę")
        val pair = TestP2pClient.pair(http(), shownCode(), extIdentity)
        assertEquals(pair.finish?.body, 200, pair.finish?.status)

        // The extension edited the same entry later than the phone did.
        val blob = EntryV3.encrypt(
            vaultKey, old.id, loginData("bank.pl", "jan.nowak", "nowe-haslo-456", Hlc(clock + 60_000, 0, extIdentity.deviceId)),
        )
        val res = client(pair).syncResponse(
            P2pSyncRequest(pair.phoneVaultInfo!!.epoch, 0, listOf(ChangeRequest(old.id, old.revision, false, blob))),
        )
        assertEquals(1, res.accepted.size)
        waitFor("Zsynchronizowano z: test-ext")
        // Already refreshed by the sync itself, before leaving sync mode.
        val vm = viewModel()
        compose.waitUntil(30_000) { vm.state.value.entries.singleOrNull()?.credentials?.username == "jan.nowak" }

        click("Zakończ")
        waitFor("jan.nowak")
        // The old login is gone from the list (exact match: "jan.nowak" contains it).
        assertTrue(compose.onAllNodes(hasText("jan")).fetchSemanticsNodes().isEmpty())

        // The edit form is filled from the store, not from a list cached before the sync.
        click("bank.pl")
        waitFor("Edytuj login")
        fieldButton("Hasło", "Pokaż").performClick()
        compose.waitForIdle()
        assertEquals("jan.nowak", editable("Login"))
        assertEquals("nowe-haslo-456", editable("Hasło"))
    }
}
