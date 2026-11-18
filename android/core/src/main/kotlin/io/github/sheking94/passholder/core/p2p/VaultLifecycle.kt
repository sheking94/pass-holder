package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.VaultCrypto
import io.github.sheking94.passholder.core.checkCode
import io.github.sheking94.passholder.core.requireCode

/**
 * Creating, restoring, unlocking and forgetting the phone's vault, and changing its master password; see the
 * methods of the same names in [PhoneVaultStore]. Every method takes [vaultLock] for its whole run (Argon2id
 * included); the state lock of [storage] only for the short steps that read or save the host state.
 */
internal class VaultLifecycle(
    private val vaultLock: Any,
    private val storage: HostStorage,
    private val session: PhoneSession,
    private val files: PhoneFiles,
    private val syncMode: PhoneSyncMode,
    private val now: () -> Long,
) {
    val hasVault: Boolean get() = storage.state?.phase is HostPhase.Ready

    val restoreInProgress: Boolean get() = storage.state?.phase is HostPhase.Restoring

    fun create(masterPassword: String) = synchronized(vaultLock) {
        checkCode(!hasVault, ErrorCode.VAULT_EXISTS)
        storage.checkNotCorrupt()
        session.lock()
        val vaultKey = VaultCrypto.newVaultKey()
        VaultKeys.wipeOnFailure(vaultKey) {
            val vault = VaultKeys.wrapWithPassword(masterPassword, vaultKey)
            val fresh = storage.newState(vault).copy(keyCheck = VaultKeys.keyCheck(vaultKey))
            syncMode.cancelPairing()
            storage.locked {
                storage.reset()
                storage.save(fresh)
            }
            start(vaultKey)
        }
    }

    fun startRestore() = synchronized(vaultLock) {
        checkCode(!hasVault, ErrorCode.VAULT_EXISTS)
        storage.checkNotCorrupt()
        session.lock()
        syncMode.cancelPairing()
        storage.locked {
            storage.reset()
            storage.save(storage.newState(null))
        }
    }

    fun finishRestore(masterPassword: String) = synchronized(vaultLock) {
        val hostState = storage.state ?: throw PassHolderException(ErrorCode.RESTORE_NOT_RUNNING)
        val phase = hostState.phase as? HostPhase.Restoring ?: throw PassHolderException(ErrorCode.RESTORE_NOT_RUNNING)
        val sent = phase.sent ?: throw PassHolderException(ErrorCode.RESTORE_NOT_SENT)
        checkCode(hostState.devices.isNotEmpty(), ErrorCode.RESTORE_NOT_SENT)
        val store = storage.records()
        checkCode(synchronized(store) { store.currentRevision() > 0 }, ErrorCode.RESTORE_NOT_SENT)
        val vaultKey = VaultKeys.unwrap(masterPassword, sent)
        VaultKeys.wipeOnFailure(vaultKey) {
            storage.locked {
                val current = storage.state
                if (current == null || current.epoch != hostState.epoch || current.wrappedVaultKey != sent.wrappedVaultKey) {
                    throw PassHolderException(ErrorCode.RESTORE_CHANGED)
                }
                storage.save(current.copy(keyCheck = VaultKeys.keyCheck(vaultKey)))
            }
            start(vaultKey)
        }
    }

    fun changeMasterPassword(oldPassword: String, newPassword: String) = synchronized(vaultLock) {
        val unlocked = session.require()
        val hostState = storage.state ?: throw PassHolderException(ErrorCode.NO_VAULT)
        val ready = hostState.phase as? HostPhase.Ready ?: throw PassHolderException(ErrorCode.NO_VAULT)
        requireCode(oldPassword != newPassword, ErrorCode.PASSWORD_UNCHANGED)
        VaultKeys.verifyPassword(oldPassword, ready.vault, unlocked.vaultKey)
        val rewrapped = VaultKeys.wrapWithPassword(newPassword, unlocked.vaultKey)
        syncMode.cancelPairing()
        storage.locked {
            val latest = storage.state
            if (latest == null || latest.epoch != hostState.epoch || latest.keyCheck != ready.keyCheck) {
                throw PassHolderException(ErrorCode.VAULT_CHANGED)
            }
            storage.save(latest.withVault(rewrapped).copy(devices = emptyList()))
        }
        session.touch()
    }

    fun confirmMasterPassword(masterPassword: String) = synchronized(vaultLock) {
        val unlocked = session.require()
        VaultKeys.verifyPassword(masterPassword, storage.requireVault().vault, unlocked.vaultKey)
    }

    fun unlock(masterPassword: String) = synchronized(vaultLock) {
        val ready = storage.requireVault()
        val vaultKey = VaultKeys.unwrap(masterPassword, ready.vault)
        VaultKeys.wipeOnFailure(vaultKey) {
            if (!VaultKeys.matchesKeyCheck(vaultKey, ready.keyCheck)) throw PassHolderException(ErrorCode.WRONG_MASTER_PASSWORD)
            start(vaultKey)
        }
    }

    fun exportVaultKey(): ByteArray = synchronized(vaultLock) { session.require().vaultKey.copyOf() }

    fun unlockWithVaultKey(key: ByteArray) = synchronized(vaultLock) {
        requireCode(key.size == VaultKeys.KEY_LENGTH, ErrorCode.WRONG_UNLOCK_KEYS)
        val ready = storage.requireVault()
        if (!VaultKeys.matchesKeyCheck(key, ready.keyCheck)) throw PassHolderException(ErrorCode.WRONG_UNLOCK_KEYS)
        val vaultKey = key.copyOf()
        VaultKeys.wipeOnFailure(vaultKey) { start(vaultKey) }
    }

    fun disconnect() = synchronized(vaultLock) {
        session.lock()
        syncMode.cancelPairing()
        storage.deleteAll()
    }

    /** Opens the session on [vaultKey] (owned from now on) over the sync store. Caller holds [vaultLock]. */
    private fun start(vaultKey: ByteArray) {
        session.lock()
        val (store, deviceId) = storage.locked { storage.records() to storage.requireState().deviceId }
        session.open(vaultKey, PhoneVault(store, vaultKey, deviceId, now))
        files.pruneQuietly()
    }
}
