package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.RemoteRecord
import io.github.sheking94.passholder.core.checkCode
import io.github.sheking94.passholder.core.files.DiskFileStore
import io.github.sheking94.passholder.core.files.FileChunk
import io.github.sheking94.passholder.core.files.FileStore
import java.io.File
import java.io.IOException
import java.nio.file.Files

/**
 * The sync store, closed for writes when a reset replaces it, so a request still running on the old host
 * cannot append to (and so recreate) a file that was just deleted.
 */
internal class ResettableStore(val inner: FileSyncStore) : SyncStore by inner {
    var closed = false

    override fun put(record: RemoteRecord) {
        check(!closed) { "Sync store was reset" }
        inner.put(record)
    }

    override fun putAll(records: List<RemoteRecord>) {
        check(!closed) { "Sync store was reset" }
        inner.putAll(records)
    }
}

/**
 * The file store, closed when a reset deletes it, so a request still running on the old host cannot
 * recreate the directory ([DiskFileStore.put] creates it). Like any [FileStore], used under its own monitor.
 */
internal class ResettableFileStore(val inner: DiskFileStore) : FileStore by inner {
    var closed = false

    override fun put(chunk: FileChunk, now: Long) {
        check(!closed) { "File store was reset" }
        inner.put(chunk, now)
    }

    override fun delete(id: String) {
        check(!closed) { "File store was reset" }
        inner.delete(id)
    }

    override fun clear() {
        check(!closed) { "File store was reset" }
        inner.clear()
    }
}

/**
 * What the phone host keeps in `dir/p2p/`: `host.json` ([HostStateStore]), `records.jsonl` ([FileSyncStore]) and
 * `files/` ([DiskFileStore]), and the [P2pHost] built on them.
 *
 * Every method takes this object's own lock (the "state lock" of [PhoneVaultStore]), which HTTP threads also take,
 * so it is held only for short disk work, never for Argon2id. [locked] runs several steps as one. Code holding it
 * takes no other monitor except the stores' (when a reset closes them), and never both stores at once.
 */
internal class HostStorage(dir: File, wrapper: SecretWrapper, private val onError: (Throwable) -> Unit) {
    private val p2pDir = File(dir, "p2p")
    private val filesDir = File(p2pDir, "files")
    private val recordsFile = File(p2pDir, "records.jsonl")
    private val stateStore = HostStateStore(File(p2pDir, "host.json"), wrapper)

    private val lock = Any()

    // All guarded by lock.
    private var current: HostState? = null

    /** host.json is there but cannot be read. Never thrown from the constructor. */
    private var corrupt = false
    private var records: ResettableStore? = null
    private var files: ResettableFileStore? = null
    private var host: P2pHost? = null

    init {
        reload()
    }

    fun <T> locked(block: () -> T): T = synchronized(lock, block)

    /** Null before the first createVault/startRestore, after [deleteAll] and while [corrupt]. */
    val state: HostState? get() = locked { current }

    /** host.json exists but is not a host state; only [deleteAll] clears it. */
    val isCorrupt: Boolean get() = locked { corrupt }

    fun checkNotCorrupt() = checkCode(!isCorrupt, ErrorCode.VAULT_UNREADABLE)

    /** The current state; a plain [IllegalStateException] without one (internal: callers check first). */
    fun requireState(): HostState = state ?: throw IllegalStateException("No host state")

    /** The vault's secrets; [ErrorCode.NO_VAULT] while there is none (also during a restore). */
    fun requireVault(): HostPhase.Ready = state?.phase as? HostPhase.Ready ?: throw PassHolderException(ErrorCode.NO_VAULT)

    /** A fresh identity ([HostStateStore.newState]), not saved yet. */
    fun newState(vault: WrappedVault?): HostState = stateStore.newState(vault?.kdf, vault?.wrappedVaultKey)

    fun staticKey(state: HostState): KeyPair = stateStore.staticKey(state)

    fun save(state: HostState) = locked {
        p2pDir.mkdirs()
        stateStore.save(state)
        current = state
        corrupt = false
    }

    /** Saves [change] of the current state; does nothing without a state or when [change] returns null. */
    fun update(change: (HostState) -> HostState?) {
        locked {
            val state = current ?: return@locked
            change(state)?.let(::save)
        }
    }

    /** Reads host.json again and drops the host built on the old state (sync mode starts). */
    fun reload() = locked {
        current = try {
            stateStore.load().also { corrupt = false }
        } catch (e: IllegalStateException) {
            markCorrupt(e)
        } catch (e: IOException) {
            markCorrupt(e)
        }
        host = null
    }

    private fun markCorrupt(e: Exception): HostState? {
        reportError(onError, e)
        corrupt = true
        return null
    }

    /** The sync store; opens the file store too. */
    fun records(): ResettableStore = locked {
        files()
        records ?: ResettableStore(FileSyncStore(recordsFile)).also { records = it }
    }

    fun files(): ResettableFileStore = locked {
        files ?: run {
            p2pDir.mkdirs()
            ResettableFileStore(DiskFileStore(filesDir)).also { files = it }
        }
    }

    /** For tests: the sync store and the host as they are now, without opening or building them. */
    internal fun openedRecords(): SyncStore? = locked { records }

    internal fun builtHost(): P2pHost? = locked { host }

    /** The host for sync mode, built once per state by [build]; null without a state. */
    fun host(build: (HostState) -> P2pHost): P2pHost? = locked {
        val state = current ?: return@locked null
        host ?: build(state).also { host = it }
    }

    /** Deletes the records file and the stored files, and drops the host built on them. */
    fun reset() = locked {
        resetFiles()
        val old = records
        if (old != null) {
            synchronized(old) {
                old.closed = true
                deleteRecordsFiles()
            }
        } else {
            deleteRecordsFiles()
        }
        records = null
        host = null
    }

    /** Forgets everything: [reset], then deletes host.json and `dir/p2p/`. */
    fun deleteAll() = locked {
        reset()
        current = null
        corrupt = false
        stateStore.delete()
        if (p2pDir.exists() && !p2pDir.deleteRecursively()) throw IOException("Cannot delete $p2pDir")
    }

    private fun resetFiles() {
        val old = files
        try {
            if (old != null) {
                synchronized(old) {
                    old.closed = true
                    deleteFilesDir()
                }
            } else {
                deleteFilesDir()
            }
        } finally {
            // Never leave a closed store behind; the next DiskFileStore open cleans a half-deleted directory.
            files = null
        }
    }

    private fun deleteFilesDir() {
        if (filesDir.exists() && !filesDir.deleteRecursively()) throw IOException("Cannot delete $filesDir")
    }

    private fun deleteRecordsFiles() {
        Files.deleteIfExists(File(recordsFile.path + ".tmp").toPath())
        Files.deleteIfExists(recordsFile.toPath())
    }
}
