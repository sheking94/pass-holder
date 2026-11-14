package io.github.sheking94.passholder.app

import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Turning the screen off locks the vault at once, with the 60 s delay on (security review N1). Also on API 30:
 * below 33 a not-exported dynamic receiver needs an extra permission, which crashed the app at start.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [30, 35])
class ScreenOffLockTest {
    private val app: PassHolderApp = ApplicationProvider.getApplicationContext()

    @Before
    fun start() {
        app.secretWrapper = TestSecretWrapper
        app.settings.lockDelay = true
        app.phoneStore.createVault("Zażółć gęślą jaźń 2026")
    }

    @After
    fun stop() = app.leaveLock.cancel().let {}

    @Test
    fun `screen off locks an unlocked vault even with the delay on`() {
        app.leaveLock.schedule(LeaveLock.DELAY_MS)
        assertTrue(app.phoneStore.isUnlocked)
        app.sendBroadcast(Intent(Intent.ACTION_SCREEN_OFF))
        shadowOf(Looper.getMainLooper()).idle()
        val until = System.currentTimeMillis() + 5_000
        while (app.phoneStore.isUnlocked && System.currentTimeMillis() < until) Thread.sleep(10)
        assertFalse(app.phoneStore.isUnlocked)
    }
}
