package io.github.sheking94.passholder.app

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlin.concurrent.thread

/**
 * The delayed lock after leaving the app ("Blokuj dopiero po 60 s poza aplikacją").
 *
 * Belongs to the process (PassHolderApp), not to the activity or the ViewModel: after Back the activity and
 * its ViewModel are gone, but the vault keys are still in memory and the timer must still lock them.
 *
 * Two safety nets, because Android may freeze a background app and delay its timers:
 *  - the timer locks the vault [delayMs] after leaving (if the app is not frozen),
 *  - on return, [cancel] compares the clock with the deadline, so a late timer never leaves the vault open;
 *    the autofill service asks [expired] before it fills from an unlocked vault, for the same reason.
 * SystemClock.elapsedRealtime keeps counting while the phone sleeps and cannot be changed by the user.
 */
class LeaveLock(
    private val store: PhoneVaultStore,
    private val now: () -> Long = SystemClock::elapsedRealtime,
    private val handler: Handler = Handler(Looper.getMainLooper()),
) {
    // Read by the autofill service on its worker thread.
    @Volatile
    private var deadline: Long? = null

    // An unlock (Argon2id) can hold the vault for seconds (PhoneVaultStore is synchronized): never wait for it on the main thread.
    private val lockTask = Runnable { thread(name = "passholder-leave-lock") { store.lock() } }

    /** The app left the screen: lock in [delayMs] unless it comes back sooner. */
    fun schedule(delayMs: Long) {
        handler.removeCallbacks(lockTask)
        deadline = now() + delayMs
        handler.postDelayed(lockTask, delayMs)
    }

    /** The app is back. Stops the timer; true when the time ran out (the caller must make sure the vault is locked). */
    fun cancel(): Boolean {
        handler.removeCallbacks(lockTask)
        val expired = deadline?.let { now() >= it } ?: false
        deadline = null
        return expired
    }

    /** The time ran out and [cancel] has not been called since; changes nothing (the caller locks). */
    fun expired(): Boolean = deadline?.let { now() >= it } ?: false

    companion object {
        const val DELAY_MS = 60_000L
    }
}
