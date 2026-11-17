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
 *  - the timer locks the vault [DELAY_MS] after leaving (if the app is not frozen),
 *  - on return, the caller asks [expired] before [cancel], so a late timer never leaves the vault open;
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

    /** The app left the screen: lock in [DELAY_MS] unless it comes back sooner. */
    fun schedule() {
        handler.removeCallbacks(lockTask)
        deadline = now() + DELAY_MS
        handler.postDelayed(lockTask, DELAY_MS)
    }

    /** The app is back: stops the timer and forgets the deadline. Ask [expired] first when the answer matters. */
    fun cancel() {
        handler.removeCallbacks(lockTask)
        deadline = null
    }

    /**
     * The screen went off: lock now, whatever the delay. The 60 s are for a short trip to another app; a phone put
     * away sleeps, and while it sleeps the timer above stands still (Handler counts uptime), so the keys would stay
     * in memory far longer than 60 s. The deadline stays, so a return still reports it the usual way.
     */
    fun lockNow() {
        handler.removeCallbacks(lockTask)
        lockTask.run()
    }

    /** The time ran out and [cancel] has not been called since; changes nothing (the caller locks). */
    fun expired(): Boolean = deadline?.let { now() >= it } ?: false

    companion object {
        const val DELAY_MS = 60_000L
    }
}
