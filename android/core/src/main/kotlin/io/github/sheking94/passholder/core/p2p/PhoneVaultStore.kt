package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.DiskFileStore
import io.github.sheking94.passholder.core.files.FileChunks
import io.github.sheking94.passholder.core.transfer.ImportedArchive
import io.github.sheking94.passholder.core.transfer.contentKey
import java.io.File
import java.io.InputStream

/**
 * Everything the app does with the phone's vault when the phone is the sync host (plan 3). A facade: the work is
 * done by its parts, which share the locks and clock below.
 *
 * | Part | Does |
 * |---|---|
 * | [HostStorage] | `host.json`, `records.jsonl`, `files/` and the state lock |
 * | [VaultLifecycle] | creating, restoring, unlocking, forgetting; master password ([VaultKeys]) |
 * | [PhoneSession] | the vault key in memory and auto-lock |
 * | [PhoneEntries], [PhoneFiles], [PhoneArchiveImport] | entries, files, ZIP import |
 * | [PhoneSyncMode] | paired devices, pairing codes, the router of sync mode |
 *
 * On disk, in `dir/p2p/`: `host.json` ([HostStateStore]: identity, epoch, KDF, wrapped vault key, paired devices)
 * `records.jsonl` ([FileSyncStore]: the encrypted entries, the same store the extension syncs with) and `files/`
 * ([DiskFileStore]: encrypted file chunks, served on `/p2p/v2/file`; emptied whenever the epoch changes).
 * In memory, only while unlocked: the vault key. It locks on [lock] and after [autoLockMs] without activity ([touch]).
 *
 * States ([HostPhase]): no vault ([hasVault] and [restoreInProgress] false), unreadable host state ([corruptState]:
 * only [disconnect] gets out of it), a restore from the extension in progress ([HostPhase.Restoring]: the extension
 * may already have sent its KDF, wrapped key and entries, but the master password has not been checked yet), and a
 * vault ([HostPhase.Ready], [hasVault]).
 *
 * Methods are blocking (Argon2id, disk): call them off the main thread.
 *
 * Locking: methods that use the vault key take the vault lock (one private object shared by the parts). The host
 * state and the sync store are guarded by the state lock of [HostStorage], which HTTP threads also take (pairing,
 * device list, last sync time), so a running Argon2id never blocks the server. Lock order: vault lock → pairing
 * host → state lock → sync store / file store; code holding the state lock never takes the others' monitors except
 * the stores'. The two stores are never locked together.
 *
 * Files: [pruneFiles] deletes stored files no live entry uses once they are older than a day; it runs after
 * unlocking and after every entry write, and never while some record cannot be read (it might use any file).
 */
class PhoneVaultStore(
    dir: File,
    wrapper: SecretWrapper,
    now: () -> Long = System::currentTimeMillis,
    /** Auto-lock after this long without [touch]. */
    autoLockMs: Long = AUTO_LOCK_MS,
    /** The name the extension shows for this phone. */
    deviceName: String = DEFAULT_DEVICE_NAME,
    /** Gets the cause of every 500 answer of sync mode (the extension only sees "internal error"); e.g. to log it. */
    onError: (Throwable) -> Unit = {},
) {
    companion object {
        const val AUTO_LOCK_MS = 15 * 60_000L
        const val DEFAULT_DEVICE_NAME = "Telefon"
    }

    private val vaultLock = Any()
    private val storage = HostStorage(dir, wrapper, onError)
    private val session = PhoneSession(now, autoLockMs)
    private val files = PhoneFiles(vaultLock, session, storage, now, onError)
    private val entries = PhoneEntries(vaultLock, session, files)
    private val archiveImport = PhoneArchiveImport(vaultLock, entries, files, onError)
    private val syncMode = PhoneSyncMode(storage, deviceName, now, onError)
    private val lifecycle = VaultLifecycle(vaultLock, storage, session, files, syncMode, now)

    /** There is a vault: created here, or restored from the extension and checked with the master password. */
    val hasVault: Boolean get() = lifecycle.hasVault

    /** [startRestore] ran and [finishRestore] has not succeeded yet. */
    val restoreInProgress: Boolean get() = lifecycle.restoreInProgress

    val isUnlocked: Boolean get() = session.isUnlocked

    /**
     * host.json exists but is not a host state (damaged file): no vault, no restore, nothing to serve.
     * Only [disconnect] clears it; creating or restoring refuses until then, so nothing overwrites it silently.
     */
    val corruptState: Boolean get() = storage.isCorrupt

    // ---- Creating ----

    /** A new, empty vault with a new identity; unlocks it. */
    fun createVault(masterPassword: String) = lifecycle.create(masterPassword)

    /** Starts "restore from the extension": a new identity without a vault; earlier records are deleted. */
    fun startRestore() = lifecycle.startRestore()

    /**
     * Ends a restore: checks [masterPassword] against the wrapped vault key the extension sent and unlocks.
     * [ErrorCode.RESTORE_NOT_SENT] while the extension has not paired and synced yet; [ErrorCode.WRONG_MASTER_PASSWORD]
     * for a wrong password (nothing changes then).
     */
    fun finishRestore(masterPassword: String) = lifecycle.finishRestore(masterPassword)

    // ---- Changing the master password ----

    /**
     * Wraps the same vault key with [newPassword] under a new salt (security review I1, variant "a"): entries,
     * epoch and identity stay, the vault key is not rotated. Every paired device is removed and a pending pairing
     * code dropped, so each extension must pair again and learns the new wrapping only with the new password.
     * Needs an unlocked vault; [oldPassword] is checked again ([ErrorCode.WRONG_MASTER_PASSWORD]).
     * The caller checks [newPassword] against its strength rules first.
     */
    fun changeMasterPassword(oldPassword: String, newPassword: String) = lifecycle.changeMasterPassword(oldPassword, newPassword)

    /**
     * Checks [masterPassword] again while unlocked, before a plain-text export (security review V3-N6): someone with
     * the unlocked phone in hand cannot take the whole vault in one file without knowing it.
     * [ErrorCode.WRONG_MASTER_PASSWORD] for a password that does not open this vault; [ErrorCode.VAULT_LOCKED] while locked.
     */
    fun confirmMasterPassword(masterPassword: String) = lifecycle.confirmMasterPassword(masterPassword)

    // ---- Locking ----

    /** Works offline: everything is on disk. */
    fun unlock(masterPassword: String) = lifecycle.unlock(masterPassword)

    /** The vault key (32 bytes) for the fingerprint unlock. Returns a copy; the caller should zero it once encrypted. */
    fun exportVaultKey(): ByteArray = lifecycle.exportVaultKey()

    /** Unlocks with the key from [exportVaultKey], checked against the stored key check in constant time. */
    fun unlockWithVaultKey(key: ByteArray) = lifecycle.unlockWithVaultKey(key)

    /** Forgets the vault key (zeroed). */
    fun lock() = synchronized(vaultLock) { session.lock() }

    /** Marks user activity; auto-lock counts from the last one. Cheap and never blocks. */
    fun touch() = session.touch()

    /** Locks if there was no activity for the auto-lock time. Returns true if the vault is (now) locked. */
    fun lockIfIdle(): Boolean = synchronized(vaultLock) { session.lockIfIdle() }

    /** Forgets this phone's vault, identity and paired devices: deletes `dir/p2p/`. */
    fun disconnect() = lifecycle.disconnect()

    // ---- Entries ----

    /** Live entries of every type sorted by name. */
    fun entries(): List<PhoneEntry> = entries.list()

    fun entry(id: String): PhoneEntry? = entries.get(id)

    /** Writes any entry content; [ErrorCode.ENTRY_TYPE_MISMATCH] for another live type, [ErrorCode.ENTRY_TOO_LARGE] leaves the store as it was. */
    fun upsertContent(id: String, content: EntryContent) = entries.upsert(id, content)

    /** Imports [entries] all or nothing; see [PhoneVault.importContents]. */
    fun importContents(entries: List<EntryContent>): ImportResult = this.entries.import(entries)

    /** Content of every live readable entry (for export). */
    fun allContents(): List<EntryContent> = entries.allContents()

    fun delete(id: String) = entries.delete(id)

    /** Records the vault key cannot open (e.g. sent by an extension of another vault). */
    fun unreadableIds(): List<String> = entries.unreadableIds()

    // ---- Files ----

    /**
     * Encrypts [bytes] and stores the complete file; returns its descriptor for the entry the UI saves next
     * (until then the file is kept for a day, see [pruneFiles]). Errors of [FileChunks.encrypt] as there.
     */
    fun addFile(bytes: ByteArray, name: String, mime: String): Attachment = files.add(bytes, name, mime)

    /** Every chunk of the file is on the phone (sent by the extension or added here). */
    fun isFileComplete(a: Attachment): Boolean = files.isComplete(a)

    /** The file's contents; [ErrorCode.FILE_CORRUPTED] when a chunk is missing or does not match. */
    fun readFile(a: Attachment): ByteArray = files.read(a)

    /**
     * Deletes stored files that no live entry uses and that are older than [io.github.sheking94.passholder.core.files.Attachments.ORPHAN_FILE_AGE_MS];
     * returns how many. Does nothing (0) while some record cannot be read: it might use any file.
     */
    fun pruneFiles(): Int = files.prune()

    /**
     * Deletes the files with the given [ids] at once (the UI uses it for files added to an entry that was not
     * saved), skipping any id a live entry uses. There is no age guard: callers must pass only ids of files they
     * just added and never saved in an entry; returns how many were deleted. Does nothing (0) while some record
     * cannot be read: it might use any file.
     */
    fun discardFiles(ids: Collection<String>): Int = files.discard(ids)

    /**
     * Imports a PassHolder ZIP read from [input] (closed at the end): the index, then the files of the entries that
     * are not already in the vault ([contentKey]), each encrypted and
     * stored with [addFile], then the entries with their files in one [importContents]. A file that is missing, too
     * large, damaged or of another size than described is left out of its entry and listed in `fileSkips`
     * ("wpis N, nazwa"). Any exception (damaged archive, no space, vault locked) imports nothing: the files added so
     * far are deleted and the exception is passed on. Files added for entries that were not imported are deleted.
     */
    fun importArchive(input: InputStream): ImportedArchive = archiveImport.import(input)

    // ---- Devices ----

    fun devices(): List<StoredDevice> = syncMode.devices()

    /** The device can no longer handshake (its next request gets 403). */
    fun removeDevice(deviceId: String) = syncMode.removeDevice(deviceId)

    // ---- Sync mode ----

    /**
     * The handler for [SyncHttpServer], for one start of sync mode. It re-reads the host state from disk, and
     * every request sees the current state (devices, a vault created or restored since). [addresses] are the
     * phone's current addresses, sent to the extension in pairing and sync answers.
     * A pairing code from an earlier start is dropped: each start of sync mode asks for its own.
     */
    fun router(onActivity: () -> Unit, addresses: () -> List<String>): PhoneRouter = syncMode.router(onActivity, addresses)

    /** A new pairing code; in restore mode while a restore is in progress. */
    fun offerPairing(): PairingOffer = syncMode.offerPairing()

    fun cancelPairing() = syncMode.cancelPairing()

    /** The offered code while it can still be used: null once it expired, was spent by /pair/start or cancelled. */
    fun currentOffer(): PairingOffer? = syncMode.currentOffer()

    // ---- Test hooks ----

    /** The sync store now open, if any: a reset must close it for writes. */
    internal fun openedRecordsForTest(): SyncStore? = storage.openedRecords()

    /** The host sync mode built, if any: a request in flight may still use it after a reset. */
    internal fun builtHostForTest(): P2pHost? = storage.builtHost()
}
