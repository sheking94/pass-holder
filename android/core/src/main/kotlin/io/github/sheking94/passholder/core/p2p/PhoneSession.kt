package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import java.util.concurrent.atomic.AtomicLong

/**
 * The unlocked vault in memory: the vault key and the [PhoneVault] over the sync store, and the auto-lock clock.
 * Callers hold the vault lock of [PhoneVaultStore] for [open], [lock] and [lockIfIdle]; [isUnlocked] and [touch]
 * need no lock.
 */
internal class PhoneSession(private val now: () -> Long, private val autoLockMs: Long) {
    class Unlocked(val vaultKey: ByteArray, val vault: PhoneVault)

    @Volatile
    private var current: Unlocked? = null

    /** Outside any lock on purpose: the UI calls [touch] on every tap and must never wait for a running Argon2id. */
    private val lastActivity = AtomicLong(0)

    val isUnlocked: Boolean get() = current != null

    /** [ErrorCode.VAULT_LOCKED] while locked. */
    fun require(): Unlocked = current ?: throw PassHolderException(ErrorCode.VAULT_LOCKED)

    /** Locks any earlier session, then keeps [vaultKey] (owned from now on) and starts the auto-lock clock. */
    fun open(vaultKey: ByteArray, vault: PhoneVault) {
        lock()
        current = Unlocked(vaultKey, vault)
        touch()
    }

    /** Forgets the vault key (zeroed). */
    fun lock() {
        current?.vaultKey?.fill(0)
        current = null
    }

    fun touch() {
        lastActivity.set(now())
    }

    /** Locks if there was no activity for [autoLockMs]. Returns true if the vault is (now) locked. */
    fun lockIfIdle(): Boolean {
        if (current == null) return true
        if (now() - lastActivity.get() >= autoLockMs) lock()
        return current == null
    }
}
