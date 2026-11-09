package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.p2p.PhoneVaultStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlin.concurrent.thread

/**
 * When the vault locks, and when the locked screen opens the fingerprint dialog by itself. Everything about the
 * lock that used to be spread over the ViewModel is here, so this one class answers both questions:
 *
 * The vault locks when
 *  - the app leaves the screen ([onLeftApp]): at once, or 60 s later through [LeaveLock] with the delay on,
 *  - the app comes back after those 60 s ran out ([onReturn]), in case the timer was late,
 *  - nothing was touched for 15 minutes ([checkIdle]),
 *  - the user presses "Zablokuj" (the ViewModel's lock(), which then calls [onLockedByUser]).
 * A system file picker opened from "Import i eksport" ([expectFilePicker]) gets the 60 s even with the delay off.
 * A lock that comes while a vault operation runs (an unlock or a new vault can take seconds) waits for it to end ([onOperationFinished]).
 *
 * The fingerprint dialog opens by itself on the locked screen when the app starts, after the idle lock and
 * after every return to the app; not after "Zablokuj", because the user would get it straight back.
 *
 * Belongs to the ViewModel (one per activity), like the screen state it changes; [LeaveLock] and the
 * [PhoneVaultStore] belong to the process.
 */
class LockController(
    private val store: PhoneVaultStore,
    /** Read on each use, not kept: it belongs to the process (PassHolderApp), which may replace it. */
    private val leaveLock: () -> LeaveLock,
    private val lockDelay: () -> Boolean,
    private val isBusy: () -> Boolean,
    private val currentScreen: () -> Screen,
    private val showLocked: (Status?) -> Unit,
) {
    /** The app left (or 60 s ran out) while a vault operation was running: lock as soon as it ends. */
    private var lockWaitsForOperation = false

    /** A file picker is about to open, or is open: see [expectFilePicker]. */
    private var filePicker = FilePicker.NONE

    /** Whether the next locked screen opens the fingerprint dialog by itself; see [takeFingerprintOffer]. */
    private var offerFingerprint = true

    private val _timesLeftApp = MutableStateFlow(0)
    /** Goes up each time the app leaves the screen; the locked screen then offers the fingerprint dialog again. */
    val timesLeftApp: StateFlow<Int> = _timesLeftApp.asStateFlow()

    /**
     * The app left the screen (MainActivity.onStop, not for a rotation). The keys live in PhoneVaultStore, which
     * belongs to the process, not to the ViewModel or the activity: without a lock they stayed in memory after
     * closing the app, until Android killed the process.
     *
     * With the delay on (default), [LeaveLock] locks 60 s later unless the user comes back sooner: switching
     * to the browser to paste a password, or a half-filled entry form, survive a short trip. With it off, or
     * once the 60 s have passed, opening the app asks for the fingerprint or the master password.
     */
    fun onLeftApp() {
        offerFingerprint = true
        _timesLeftApp.update { it + 1 }
        val picking = filePicker == FilePicker.EXPECTED
        filePicker = if (picking) FilePicker.OPEN else FilePicker.NONE
        if (!store.isUnlocked) return
        if (picking || lockDelay()) leaveLock().schedule(LeaveLock.DELAY_MS) else lockNow()
    }

    /** The app is on screen again (MainActivity.onStart). Locks if the 60 s after leaving ran out. */
    fun onReturn() {
        val picking = filePicker == FilePicker.OPEN
        filePicker = FilePicker.NONE
        val expired = leaveLock().cancel()
        when {
            // The timer may have locked already; the locked screen still says why.
            expired && picking -> lockNow(Status(FILE_PICK_TOO_LONG))
            expired && store.isUnlocked -> lockNow()
        }
        showLockedIfLocked()
    }

    /**
     * The system file picker opens next (called just before it is launched). It is another app, so the activity
     * stops: that one trip gets the 60 s of [LeaveLock] even with the delay off, and the vault locks if it takes
     * longer. Only for the picker: the next leave after it locks as the setting says.
     */
    fun expectFilePicker() {
        filePicker = FilePicker.EXPECTED
    }

    /** The picker returned (a file or a cancel). If it never took the app off screen, the window is dropped. */
    fun filePickerClosed() {
        filePicker = FilePicker.NONE
    }

    /** The 15-minute idle lock. Checked every 15 s and on return; the check itself runs off the main thread. */
    suspend fun checkIdle() {
        if (!currentScreen().showsVault || isBusy()) return
        if (withContext(Dispatchers.IO) { store.lockIfIdle() }) {
            offerFingerprint = true
            showLocked(Status("Zablokowano po 15 minutach bezczynności."))
        }
    }

    /** "Zablokuj": the user is looking at the app, so the locked screen must not open the dialog by itself. */
    fun onLockedByUser() {
        offerFingerprint = false
    }

    /** Called once by the locked screen when it appears: true means "open the fingerprint dialog now". */
    fun takeFingerprintOffer(fingerprintEnabled: Boolean): Boolean {
        val open = offerFingerprint && fingerprintEnabled
        offerFingerprint = false
        return open
    }

    /** A vault operation ended: run the lock that waited for it, and leave the vault screens if it is locked. */
    fun onOperationFinished() {
        if (lockWaitsForOperation) {
            lockWaitsForOperation = false
            lockNow()
        }
        showLockedIfLocked()
    }

    /** The activity is closed for good. If a running operation still waits to be followed by the lock, lock off the main thread. */
    fun onCleared() {
        if (lockWaitsForOperation) thread(name = "passholder-lock") { store.lock() }
    }

    /**
     * Locks the vault and shows the locked screen. lock() only zeroes the vault key, so it runs on the main
     * thread; but while an operation is running it holds the vault, so the lock waits until the operation
     * ends instead of blocking the main thread.
     */
    private fun lockNow(status: Status? = null) {
        if (isBusy()) {
            lockWaitsForOperation = true
            return
        }
        store.lock()
        showLocked(status)
    }

    /** The 60 s timer locks the vault in the background; the screens must not go on showing entries then. */
    private fun showLockedIfLocked() {
        if (currentScreen().showsVault && !isBusy() && !store.isUnlocked) showLocked(null)
    }

    private enum class FilePicker { NONE, EXPECTED, OPEN }

    companion object {
        const val FILE_PICK_TOO_LONG = "Zablokowano: wybór pliku trwał ponad 60 s"
    }
}
