package io.github.sheking94.passholder.app

import android.content.Context
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import android.os.Looper
import java.time.Duration
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Robolectric has no Android Keystore and no fingerprint reader. These fakes stand in for exactly those two
 * pieces; everything else (BiometricUnlock, the ViewModel, VaultStore, the screens) is the real code.
 */
class SoftwareKeyProtector : UnlockKeyProtector {
    var key: SecretKey? = null

    override fun newEncryptCipher(): Cipher {
        key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
    }

    override fun decryptCipher(iv: ByteArray): Cipher? =
        key?.let { Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, it, GCMParameterSpec(128, iv)) } }

    override fun deleteKey() { key = null }
}

/** A finger that always matches, unless [cancel] is set (the user pressed "Użyj hasła głównego"). */
class FakeFingerprintPrompt : FingerprintPrompt {
    var shown = 0
    var cancel = false

    override fun availability(context: Context) = BiometricAvailability.Ready

    override fun authenticate(activity: FragmentActivity, title: String, cipher: Cipher, onSuccess: (Cipher) -> Unit, onError: (String?) -> Unit) {
        shown++
        if (cancel) onError(null) else onSuccess(cipher)
    }
}

abstract class BiometricTestBase : ScreenTestBase() {
    protected val keys = SoftwareKeyProtector()
    protected val finger = FakeFingerprintPrompt()
    protected lateinit var app: PassHolderApp

    override fun beforeLaunch(app: PassHolderApp) {
        this.app = app
        app.biometric = BiometricUnlock(app, keys)
        app.biometric.disable()
        app.fingerprintPrompt = finger
        app.settings.lockDelay = lockDelay
    }

    /** Most tests check the immediate lock; the 60 s delay has its own tests. */
    protected open val lockDelay = false

    protected fun createVaultWithFingerprint() {
        createVault()
        finishCreate()
        addEntry("bank.pl", "jan.kowalski", "s3cret-haslo")
        click("Zapisz")
        waitFor("Zapisano na telefonie", substring = true)
        shot("12-odcisk-wylaczony")
        click("Odblokowanie odciskiem palca")
        waitFor("Włączono odblokowanie odciskiem palca", substring = true)
        assertTrue(app.biometric.isEnabled)
        shot("13-odcisk-wlaczony")
    }

    /**
     * The app is closed (Back, or swiped away from recent apps) and opened again; the process lives on, like on
     * a real phone. Nothing here locks the vault by hand: closing the activity must do it.
     */
    protected fun reopenLocked() {
        scenario.close()
        assertFalse("closing the app must lock the vault", app.vaultStore.isUnlocked)
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }
}

class FingerprintUnlockTest : BiometricTestBase() {
    @Test
    fun `turn on, unlock with a finger after Zablokuj and on app start`() {
        createVaultWithFingerprint()
        assertEquals(1, finger.shown)

        // After "Zablokuj" the dialog does not pop up by itself; the button opens it.
        click("Zablokuj")
        waitFor("Odblokuj odciskiem palca")
        assertEquals(1, finger.shown)
        shot("14-blokada-z-odciskiem")
        click("Odblokuj odciskiem palca")
        waitFor("bank.pl •")
        assertEquals(2, finger.shown)

        // Opening the app shows the fingerprint dialog straight away.
        reopenLocked()
        waitFor("bank.pl •")
        assertEquals(3, finger.shown)
    }
}

class FingerprintFallbackTest : BiometricTestBase() {
    @Test
    fun `cancelling leaves the master password, and turning it off removes the button`() {
        createVaultWithFingerprint()
        finger.cancel = true
        reopenLocked()
        waitFor("PassHolder jest zablokowany")
        assertEquals(2, finger.shown)
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        waitFor("bank.pl •")

        click("Odblokowanie odciskiem palca")
        waitFor("Wyłączono odblokowanie odciskiem palca.")
        assertFalse(app.biometric.isEnabled)
        click("Zablokuj")
        waitFor("PassHolder jest zablokowany")
        assertTrue(gone("Odblokuj odciskiem palca"))
    }
}

class FingerprintKeyLostTest : BiometricTestBase() {
    @Test
    fun `a new fingerprint in the phone destroys the key and the app says to use the master password`() {
        createVaultWithFingerprint()
        click("Zablokuj")
        waitFor("Odblokuj odciskiem palca")
        keys.deleteKey() // what Android does to the Keystore key when a fingerprint is added
        click("Odblokuj odciskiem palca")
        waitFor("Odcisk palca przestał działać", substring = true)
        assertFalse(app.biometric.isEnabled)
        assertTrue(gone("Odblokuj odciskiem palca"))
        shot("15-odcisk-niewazny")
    }
}

class FingerprintDisconnectTest : BiometricTestBase() {
    @Test
    fun `disconnecting the phone also forgets the fingerprint keys`() {
        createVaultWithFingerprint()
        click("Zablokuj")
        waitFor("Odłącz ten telefon")
        click("Odłącz ten telefon")
        waitFor("Odłączyć telefon?")
        click("Odłącz")
        waitFor("Nowy sejf")
        assertFalse(app.biometric.isEnabled)
        assertEquals(null, keys.key)
    }
}

class FingerprintEveryOpenTest : BiometricTestBase() {
    @Test
    fun `going to the background locks, coming back asks for the finger, rotating does not lock`() {
        createVaultWithFingerprint()
        assertEquals(1, finger.shown)

        // A rotation recreates the activity, but the user never left: still unlocked, no dialog.
        scenario.recreate()
        waitFor("bank.pl •")
        assertTrue(app.vaultStore.isUnlocked)
        assertEquals(1, finger.shown)

        // Home button (or another app on top): the activity stops and the vault locks at once.
        finger.cancel = true
        scenario.moveToState(Lifecycle.State.CREATED)
        assertFalse(app.vaultStore.isUnlocked)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("PassHolder jest zablokowany")
        assertEquals(2, finger.shown)
        shot("16-powrot-z-tla")

        // The dialog was cancelled; leaving and coming back while locked offers it again.
        finger.cancel = false
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("bank.pl •")
        assertEquals(3, finger.shown)
    }
}

class FingerprintAfterManualLockTest : BiometricTestBase() {
    @Test
    fun `after Zablokuj, leaving and coming back opens the dialog again`() {
        createVaultWithFingerprint()
        click("Zablokuj")
        waitFor("Odblokuj odciskiem palca")
        assertEquals(1, finger.shown)
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("bank.pl •")
        assertEquals(2, finger.shown)
    }
}

class LockOnLeaveWithoutFingerprintTest : ScreenTestBase() {
    override fun beforeLaunch(app: PassHolderApp) {
        app.settings.lockDelay = false
    }

    @Test
    fun `without fingerprint unlock, closing and reopening asks for the master password`() {
        createVault()
        finishCreate()
        val app = androidx.test.core.app.ApplicationProvider.getApplicationContext<PassHolderApp>()
        scenario.close()
        assertFalse(app.vaultStore.isUnlocked)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        waitFor("PassHolder jest zablokowany")
        type("Hasło główne", masterPassword)
        click("Odblokuj")
        waitFor("Brak wpisów. Dodaj pierwszy.")
    }
}

/** Robolectric's clock only moves when told to: this is "the phone sat in the pocket for [seconds]". */
private fun passTime(seconds: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(seconds))

class LockDelayTest : BiometricTestBase() {
    override val lockDelay = true

    @Test
    fun `with the delay on, a short trip keeps the vault and the form, after 60 s it locks`() {
        createVaultWithFingerprint()
        assertEquals(1, finger.shown)
        shot("17-opoznienie-blokady")

        // Half-filled form, then out to another app for 30 s.
        click("+ Dodaj")
        type("Nazwa serwisu", "poczta.pl")
        scenario.moveToState(Lifecycle.State.CREATED)
        passTime(30)
        assertTrue(app.vaultStore.isUnlocked)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("poczta.pl")
        assertEquals(1, finger.shown)

        // Out again for over a minute: the timer locks while the app is in the background.
        scenario.moveToState(Lifecycle.State.CREATED)
        passTime(61)
        compose.waitUntil(5_000) { !app.vaultStore.isUnlocked }
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("bank.pl •")
        assertEquals(2, finger.shown)
    }
}

class LockDelayLateTimerTest : BiometricTestBase() {
    override val lockDelay = true

    @Test
    fun `a timer that did not fire (app frozen in the background) still locks on return`() {
        createVaultWithFingerprint()
        scenario.moveToState(Lifecycle.State.CREATED)
        // Android froze the app: the timer never ran, but the clock went on past the deadline.
        app.leaveLock.cancel()
        var t = 0L
        app.leaveLock = LeaveLock(app.vaultStore, now = { t }).also { it.schedule(LeaveLock.DELAY_MS) }
        t = 61_000L
        assertTrue(app.vaultStore.isUnlocked)
        finger.cancel = true
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("PassHolder jest zablokowany")
        assertFalse(app.vaultStore.isUnlocked)
        assertEquals(2, finger.shown)
    }
}

class LockDelaySwitchOffTest : BiometricTestBase() {
    override val lockDelay = true

    @Test
    fun `the switch turns the delay off, leaving locks at once, and the choice is remembered`() {
        createVaultWithFingerprint()
        click("Blokuj dopiero po 60 s poza aplikacją")
        waitFor("Sejf blokuje się od razu po wyjściu z aplikacji.")
        assertFalse(app.settings.lockDelay)
        shot("18-opoznienie-wylaczone")
        scenario.moveToState(Lifecycle.State.CREATED)
        assertFalse(app.vaultStore.isUnlocked)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitFor("bank.pl •")
        assertEquals(2, finger.shown)
    }
}
