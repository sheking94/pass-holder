package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.Kdf
import io.github.sheking94.passholder.core.KdfParams
import io.github.sheking94.passholder.core.RemoteRecord
import io.github.sheking94.passholder.core.VaultCrypto
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.DiskFileStore
import io.github.sheking94.passholder.core.files.FileChunks
import io.github.sheking94.passholder.core.files.FileHost
import io.github.sheking94.passholder.core.files.FileStore
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Everything the app does with the phone's vault when the phone is the sync host (plan 3).
 *
 * On disk, in `dir/p2p/`: `host.json` ([HostStateStore]: identity, epoch, KDF, wrapped vault key, paired devices)
 * `records.jsonl` ([FileSyncStore]: the encrypted entries, the same store the extension syncs with) and `files/`
 * ([DiskFileStore]: encrypted file chunks, served on `/p2p/v2/file`; emptied whenever the epoch changes).
 * In memory, only while unlocked: the vault key. It locks on [lock] and after [autoLockMs] without activity ([touch]).
 *
 * States: no vault ([hasVault] and [restoreInProgress] false), unreadable host state ([corruptState]: only
 * [disconnect] gets out of it), a restore from the extension in progress
 * (host state without a key check: the extension may already have sent its KDF, wrapped key and entries,
 * but the master password has not been checked yet), and a vault ([hasVault]).
 *
 * Methods are blocking (Argon2id, disk): call them off the main thread.
 *
 * Locking: methods that use the vault key are synchronized on this object. The host state and the sync store
 * are guarded by [stateLock], which HTTP threads also take (pairing, device list, last sync time), so a running
 * Argon2id never blocks the server. Lock order: this → pairing host → [stateLock] → sync store / file store; code
 * holding [stateLock] never takes the others' monitors except the stores'. The two stores are never locked together.
 *
 * Files: [pruneFiles] deletes stored files no live entry uses once they are older than a day; it runs after
 * unlocking and after every entry write, and never while some record cannot be read (it might use any file).
 */
class PhoneVaultStore(
    dir: File,
    wrapper: SecretWrapper,
    private val now: () -> Long = System::currentTimeMillis,
    private val autoLockMs: Long = AUTO_LOCK_MS,
    /** The name the extension shows for this phone. */
    private val deviceName: String = DEFAULT_DEVICE_NAME,
    /** Gets the cause of every 500 answer of sync mode (the extension only sees "internal error"); e.g. to log it. */
    private val onError: (Throwable) -> Unit = {},
) {
    companion object {
        const val AUTO_LOCK_MS = 15 * 60_000L
        const val DEFAULT_DEVICE_NAME = "Telefon"
        private const val KEY_LENGTH = 32
        private val KEY_CHECK_INFO = Encoding.utf8("passholder/v2/key-check")

        /** Base64 HMAC-SHA256(vaultKey, "passholder/v2/key-check"): checks a vault key without any entry. */
        internal fun keyCheck(vaultKey: ByteArray): String {
            val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(vaultKey, "HmacSHA256")) }
            return Encoding.toBase64(mac.doFinal(KEY_CHECK_INFO))
        }
    }

    private class Session(val vaultKey: ByteArray, val vault: PhoneVault)

    /**
     * The sync store, closed for writes when a reset replaces it, so a request still running on the old host
     * cannot append to (and so recreate) a file that was just deleted.
     */
    private class ResettableStore(val inner: FileSyncStore) : SyncStore by inner {
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
    private class ResettableFileStore(val inner: DiskFileStore) : FileStore by inner {
        var closed = false

        override fun put(id: String, index: Int, chunks: Int, blob: String, now: Long) {
            check(!closed) { "File store was reset" }
            inner.put(id, index, chunks, blob, now)
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

    private val p2pDir = File(dir, "p2p")
    private val filesDir = File(p2pDir, "files")
    private val stateStore = HostStateStore(File(p2pDir, "host.json"), wrapper)
    private val recordsFile = File(p2pDir, "records.jsonl")

    private val stateLock = Any()

    // Guarded by stateLock.
    private var state: HostState? = null

    /** host.json is there but cannot be read; guarded by [stateLock]. Never thrown from the constructor. */
    private var corrupt = false

    init {
        synchronized(stateLock) { state = loadState() }
    }
    private var records: ResettableStore? = null
    private var files: ResettableFileStore? = null
    private var host: P2pHost? = null
    private var addresses: () -> List<String> = { emptyList() }

    /** (deviceId, Base64 static public key) of the current identity, so pairing does not unwrap the private key each time. */
    private var publicKeyCache: Pair<String, String>? = null

    private val pairing = PairingHost(::identity, ::vaultInfo, ::onPaired, now, onError)

    @Volatile
    private var session: Session? = null

    /** Outside the lock on purpose: the UI calls [touch] on every tap and must never wait for a running Argon2id. */
    private val lastActivity = AtomicLong(0)

    /** There is a vault: created here, or restored from the extension and checked with the master password. */
    val hasVault: Boolean get() = synchronized(stateLock) { state?.let { it.kdf != null && it.keyCheck != null } == true }

    /** [startRestore] ran and [finishRestore] has not succeeded yet. */
    val restoreInProgress: Boolean get() = synchronized(stateLock) { state?.let { it.keyCheck == null } == true }

    val isUnlocked: Boolean get() = session != null

    /**
     * host.json exists but is not a host state (damaged file): no vault, no restore, nothing to serve.
     * Only [disconnect] clears it; creating or restoring refuses until then, so nothing overwrites it silently.
     */
    val corruptState: Boolean get() = synchronized(stateLock) { corrupt }

    // ---- Creating ----

    /** A new, empty vault with a new identity; unlocks it. */
    @Synchronized
    fun createVault(masterPassword: String) {
        check(!hasVault) { "Na telefonie już jest sejf" }
        checkNotCorrupt()
        lock()
        val kdf = Kdf.newParams()
        val keys = Kdf.deriveKeys(masterPassword, kdf)
        val vaultKey = VaultCrypto.newVaultKey()
        val wrapped = try {
            VaultCrypto.wrapVaultKey(keys.encKey, vaultKey)
        } finally {
            keys.encKey.fill(0)
            keys.authKey.fill(0)
        }
        try {
            val fresh = stateStore.newState(kdf, wrapped).copy(keyCheck = keyCheck(vaultKey))
            pairing.cancel()
            synchronized(stateLock) {
                resetRecords()
                saveState(fresh)
            }
            start(vaultKey)
        } catch (e: Throwable) {
            vaultKey.fill(0)
            throw e
        }
    }

    /** Starts "restore from the extension": a new identity without a vault; earlier records are deleted. */
    @Synchronized
    fun startRestore() {
        check(!hasVault) { "Na telefonie już jest sejf" }
        checkNotCorrupt()
        lock()
        pairing.cancel()
        synchronized(stateLock) {
            resetRecords()
            saveState(stateStore.newState(null, null))
        }
    }

    /**
     * Ends a restore: checks [masterPassword] against the wrapped vault key the extension sent and unlocks.
     * IllegalStateException while the extension has not paired and synced yet; IllegalArgumentException for a
     * wrong password (nothing changes then).
     */
    @Synchronized
    fun finishRestore(masterPassword: String) {
        val notSent = "Wtyczka jeszcze nie przesłała sejfu"
        val s = synchronized(stateLock) { state }
        check(s != null && s.keyCheck == null) { "Odtwarzanie z wtyczki nie trwa" }
        val kdf = s.kdf ?: throw IllegalStateException(notSent)
        val wrapped = s.wrappedVaultKey ?: throw IllegalStateException(notSent)
        check(s.devices.isNotEmpty()) { notSent }
        val store = synchronized(stateLock) { openRecords() }
        check(synchronized(store) { store.currentRevision() > 0 }) { notSent }
        val vaultKey = unwrap(masterPassword, kdf, wrapped)
        try {
            synchronized(stateLock) {
                val current = state
                if (current == null || current.epoch != s.epoch || current.wrappedVaultKey != wrapped) {
                    throw IllegalStateException("Odtwarzanie zmieniło się w trakcie, spróbuj jeszcze raz")
                }
                saveState(current.copy(keyCheck = keyCheck(vaultKey)))
            }
            start(vaultKey)
        } catch (e: Throwable) {
            vaultKey.fill(0)
            throw e
        }
    }

    // ---- Locking ----

    /** Works offline: everything is on disk. */
    @Synchronized
    fun unlock(masterPassword: String) {
        val s = requireVault()
        val vaultKey = unwrap(masterPassword, s.kdf!!, s.wrappedVaultKey!!)
        try {
            if (!MessageDigest.isEqual(Encoding.utf8(keyCheck(vaultKey)), Encoding.utf8(s.keyCheck!!))) {
                throw IllegalArgumentException("Złe hasło główne")
            }
            start(vaultKey)
        } catch (e: Throwable) {
            vaultKey.fill(0)
            throw e
        }
    }

    /** The vault key (32 bytes) for the fingerprint unlock. Returns a copy; the caller should zero it once encrypted. */
    @Synchronized
    fun exportUnlockKeys(): ByteArray = requireSession().vaultKey.copyOf()

    /** Unlocks with keys from [exportUnlockKeys], checked against the stored key check in constant time. */
    @Synchronized
    fun unlockWithKeys(keys: ByteArray) {
        require(keys.size == KEY_LENGTH) { "Złe klucze odblokowania" }
        val s = requireVault()
        if (!MessageDigest.isEqual(Encoding.utf8(keyCheck(keys)), Encoding.utf8(s.keyCheck!!))) {
            throw IllegalArgumentException("Złe klucze odblokowania")
        }
        val vaultKey = keys.copyOf()
        try {
            start(vaultKey)
        } catch (e: Throwable) {
            vaultKey.fill(0)
            throw e
        }
    }

    /** Forgets the vault key (zeroed). */
    @Synchronized
    fun lock() {
        session?.vaultKey?.fill(0)
        session = null
    }

    /** Marks user activity; auto-lock counts from the last one. Cheap and never blocks. */
    fun touch() {
        lastActivity.set(now())
    }

    /** Locks if there was no activity for [autoLockMs]. Returns true if the vault is (now) locked. */
    @Synchronized
    fun lockIfIdle(): Boolean {
        if (session == null) return true
        if (now() - lastActivity.get() >= autoLockMs) lock()
        return session == null
    }

    /** Forgets this phone's vault, identity and paired devices: deletes `dir/p2p/`. */
    @Synchronized
    fun disconnect() {
        lock()
        pairing.cancel()
        synchronized(stateLock) {
            resetRecords()
            state = null
            corrupt = false
            stateStore.delete()
            if (p2pDir.exists() && !p2pDir.deleteRecursively()) throw IOException("Cannot delete $p2pDir")
        }
    }

    // ---- Entries ----

    /** Live entries of every type sorted by name. */
    @Synchronized
    fun entries(): List<PhoneEntry> = requireSession().vault.entries()

    @Synchronized
    fun entry(id: String): PhoneEntry? = entries().firstOrNull { it.id == id }

    @Synchronized
    fun upsert(id: String, credentials: Credentials) {
        requireSession().vault.upsert(id, credentials)
        touch()
        pruneQuietly()
    }

    /** Writes any entry content; [EntryTypeMismatchException] for another live type, [EntryTooLargeException] leaves the store as it was. */
    @Synchronized
    fun upsertContent(id: String, content: EntryContentV3) {
        requireSession().vault.upsertContent(id, content)
        touch()
        pruneQuietly()
    }

    /** Imports [entries] all or nothing; see [PhoneVault.importContents]. */
    @Synchronized
    fun importContents(entries: List<EntryContentV3>): ImportResult {
        val result = requireSession().vault.importContents(entries)
        touch()
        return result
    }

    /** Content of every live readable entry (for export). */
    @Synchronized
    fun allContents(): List<EntryContentV3> {
        val result = requireSession().vault.entries().map { it.content }
        touch()
        return result
    }

    @Synchronized
    fun delete(id: String) {
        requireSession().vault.delete(id)
        touch()
        pruneQuietly()
    }

    /** Records the vault key cannot open (e.g. sent by an extension of another vault). */
    @Synchronized
    fun unreadableIds(): List<String> = requireSession().vault.unreadableIds()

    // ---- Files ----

    /**
     * Encrypts [bytes] and stores the complete file; returns its descriptor for the entry the UI saves next
     * (until then the file is kept for a day, see [pruneFiles]). Errors of [FileChunks.encrypt] as there.
     */
    @Synchronized
    fun addFile(bytes: ByteArray, name: String, mime: String): Attachment {
        requireSession()
        val enc = FileChunks.encrypt(bytes, name, mime)
        val a = enc.attachment
        val store = openFiles()
        synchronized(store) {
            check(store.canStore(enc.blobs.sumOf { it.length.toLong() })) { "Za mało miejsca na telefonie" }
            val t = now()
            enc.blobs.forEachIndexed { i, blob -> store.put(a.id, i, a.chunks, blob, t) }
        }
        touch()
        return a
    }

    /** Every chunk of the file is on the phone (sent by the extension or added here). */
    @Synchronized
    fun isFileComplete(a: Attachment): Boolean {
        requireSession()
        val store = openFiles()
        return synchronized(store) { store.chunks(a.id) == a.chunks && store.have(a.id).size == a.chunks }
    }

    /** The file's contents; IllegalArgumentException("File is corrupted") when a chunk is missing or does not match. */
    @Synchronized
    fun readFile(a: Attachment): ByteArray {
        requireSession()
        val store = openFiles()
        val blobs = synchronized(store) {
            if (store.chunks(a.id) != a.chunks) throw IllegalArgumentException(FileChunks.FILE_CORRUPTED)
            (0 until a.chunks).map { store.get(a.id, it) ?: throw IllegalArgumentException(FileChunks.FILE_CORRUPTED) }
        }
        touch()
        return FileChunks.decrypt(a, blobs)
    }

    /**
     * Deletes stored files that no live entry uses and that are older than [io.github.sheking94.passholder.core.files.Attachments.ORPHAN_FILE_AGE_MS];
     * returns how many. Does nothing (0) while some record cannot be read: it might use any file.
     */
    fun pruneFiles(): Int {
        val (used, store) = synchronized(this) {
            val vault = requireSession().vault
            if (vault.unreadableIds().isNotEmpty()) return 0
            vault.entries().flatMap { e -> e.content.attachments.map { it.id } }.toSet() to openFiles()
        }
        return synchronized(store) {
            // A reset since the entries were listed: the old files are gone already.
            if (store.closed) return 0
            val orphans = FileHost.orphanIds(store, used, now())
            orphans.forEach(store::delete)
            orphans.size
        }
    }

    /** [pruneFiles] after unlocking or an entry write: a failure must not fail that, it only goes to [onError]. */
    private fun pruneQuietly() {
        try {
            pruneFiles()
        } catch (e: Exception) {
            reportError(onError, e)
        }
    }

    // ---- Devices ----

    fun devices(): List<StoredDevice> = synchronized(stateLock) { state?.devices.orEmpty() }

    /** The device can no longer handshake (its next request gets 403). */
    fun removeDevice(deviceId: String) = synchronized(stateLock) {
        val s = state ?: return@synchronized
        if (s.devices.none { it.deviceId == deviceId }) return@synchronized
        saveState(s.copy(devices = s.devices.filter { it.deviceId != deviceId }))
    }

    // ---- Sync mode ----

    /**
     * The handler for [SyncHttpServer], for one start of sync mode. It re-reads the host state from disk, and
     * every request sees the current state (devices, a vault created or restored since). [addresses] are the
     * phone's current addresses, sent to the extension in pairing and sync answers.
     * A pairing code from an earlier start is dropped: each start of sync mode asks for its own.
     */
    fun router(onRequest: () -> Unit, addresses: () -> List<String>): PhoneRouter {
        pairing.cancel()
        synchronized(stateLock) {
            this.addresses = addresses
            state = loadState()
            host = null
        }
        return PhoneRouter(pairing, ::currentHost, onRequest, onError)
    }

    /** A new pairing code; in restore mode while a restore is in progress. */
    fun offerPairing(): PairingOffer {
        val mode = synchronized(stateLock) {
            val s = state ?: throw IllegalStateException("Brak sejfu na telefonie")
            if (s.keyCheck == null) PairingMode.RESTORE else PairingMode.PAIR
        }
        return pairing.offer(mode)
    }

    fun cancelPairing() = pairing.cancel()

    /** The offered code while it can still be used: null once it expired, was spent by /pair/start or cancelled. */
    fun currentOffer(): PairingOffer? = pairing.current()

    // ---- Internals ----

    /** Null before the first createVault/startRestore. Works while locked: the host only moves opaque blobs. */
    private fun currentHost(): P2pHost? = synchronized(stateLock) {
        val s = state ?: return@synchronized null
        host ?: P2pHost(
            staticKey = stateStore.staticKey(s),
            devices = ::pairedDevices,
            store = openRecords(),
            epoch = s.epoch,
            addresses = { currentAddresses() },
            now = now,
            onSynced = ::onSynced,
            onError = onError,
            files = openFiles(),
        ).also { host = it }
    }

    private fun currentAddresses(): List<String> = synchronized(stateLock) { addresses }()

    private fun pairedDevices(): List<PairedDevice> = devices().map { it.toPairedDevice() }

    private fun onSynced(deviceId: String) = synchronized(stateLock) {
        val s = state ?: return@synchronized
        if (s.devices.none { it.deviceId == deviceId }) return@synchronized
        val t = now()
        saveState(s.copy(devices = s.devices.map { if (it.deviceId == deviceId) it.copy(lastSyncAt = t) else it }))
    }

    private fun identity(): DeviceIdentity = synchronized(stateLock) {
        val s = state ?: throw IllegalStateException("No host state")
        val cached = publicKeyCache?.takeIf { it.first == s.deviceId }?.second
        val publicKey = cached ?: run {
            val pair = stateStore.staticKey(s)
            pair.privateKey.fill(0)
            Encoding.toBase64(pair.publicKey).also { publicKeyCache = s.deviceId to it }
        }
        DeviceIdentity(s.deviceId, deviceName, publicKey)
    }

    private fun vaultInfo(@Suppress("UNUSED_PARAMETER") restored: VaultInfo?): VaultInfo {
        val list = currentAddresses().take(Pairing.MAX_ADDRESSES)
        return synchronized(stateLock) {
            val s = state ?: throw IllegalStateException("No host state")
            VaultInfo(
                s.epoch,
                s.kdf ?: throw IllegalStateException("No vault"),
                s.wrappedVaultKey ?: throw IllegalStateException("No vault"),
                list,
            )
        }
    }

    /** The same deviceId replaces the earlier entry; in restore mode also keeps the extension's KDF and wrapped key. */
    private fun onPaired(device: StoredDevice, restored: VaultInfo?) = synchronized(stateLock) {
        val s = state ?: throw IllegalStateException("No host state")
        val restoring = s.keyCheck == null
        // The offer's mode was fixed when it was made; refuse if the phone's state changed since.
        check(restoring == (restored != null)) { "Pairing mode no longer matches the vault" }
        // Once an extension sent its vault for the restore, only that extension may pair again (and resend it).
        if (restored != null && s.kdf != null) {
            check(s.devices.any { it.deviceId == device.deviceId }) { "Restore already started by another device" }
        }
        val devices = s.devices.filter { it.deviceId != device.deviceId } + device
        saveState(
            if (restored == null) {
                s.copy(devices = devices)
            } else {
                s.copy(devices = devices, kdf = restored.kdf, wrappedVaultKey = restored.wrappedVaultKey)
            },
        )
    }

    /** Caller holds [stateLock]. */
    private fun saveState(s: HostState) {
        p2pDir.mkdirs()
        stateStore.save(s)
        state = s
        corrupt = false
    }

    /** Caller holds [stateLock]. The state on disk; null (and [corrupt] set) when host.json cannot be read. */
    private fun loadState(): HostState? = try {
        stateStore.load().also { corrupt = false }
    } catch (e: IllegalStateException) {
        markCorrupt(e)
    } catch (e: IOException) {
        markCorrupt(e)
    }

    /** Caller holds [stateLock]. */
    private fun markCorrupt(e: Exception): HostState? {
        reportError(onError, e)
        corrupt = true
        return null
    }

    private fun checkNotCorrupt() = check(!corruptState) {
        "Nie mogę odczytać danych sejfu na telefonie. Najpierw je usuń."
    }

    /** Caller holds [stateLock]. Opens the file store too. */
    private fun openRecords(): ResettableStore {
        openFilesLocked()
        return records ?: ResettableStore(FileSyncStore(recordsFile)).also { records = it }
    }

    /** Caller holds [stateLock]. */
    private fun openFilesLocked(): ResettableFileStore = files ?: run {
        p2pDir.mkdirs()
        ResettableFileStore(DiskFileStore(filesDir)).also { files = it }
    }

    private fun openFiles(): ResettableFileStore = synchronized(stateLock) { openFilesLocked() }

    /** Caller holds [stateLock]. Deletes the records file and the stored files, and drops the host built on them. */
    private fun resetRecords() {
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

    /** Caller holds [stateLock]. */
    private fun resetFiles() {
        val old = files
        if (old != null) {
            synchronized(old) {
                old.closed = true
                deleteFilesDir()
            }
        } else {
            deleteFilesDir()
        }
        files = null
    }

    private fun deleteFilesDir() {
        if (filesDir.exists() && !filesDir.deleteRecursively()) throw IOException("Cannot delete $filesDir")
    }

    private fun deleteRecordsFiles() {
        Files.deleteIfExists(File(recordsFile.path + ".tmp").toPath())
        Files.deleteIfExists(recordsFile.toPath())
    }

    private fun unwrap(masterPassword: String, kdf: KdfParams, wrapped: String): ByteArray {
        val keys = Kdf.deriveKeys(masterPassword, kdf)
        return try {
            VaultCrypto.unwrapVaultKey(keys.encKey, wrapped)
        } catch (e: Exception) {
            throw IllegalArgumentException("Złe hasło główne", e)
        } finally {
            keys.encKey.fill(0)
            keys.authKey.fill(0)
        }
    }

    private fun requireVault(): HostState {
        val s = synchronized(stateLock) { state }
        check(s != null && s.kdf != null && s.wrappedVaultKey != null && s.keyCheck != null) { "Brak sejfu na telefonie" }
        return s
    }

    private fun requireSession(): Session = session ?: throw IllegalStateException("Sejf jest zablokowany")

    /** Caller holds this object's lock. */
    private fun start(vaultKey: ByteArray) {
        lock()
        val (store, deviceId) = synchronized(stateLock) {
            openRecords() to (state ?: throw IllegalStateException("No host state")).deviceId
        }
        session = Session(vaultKey, PhoneVault(store, vaultKey, deviceId, now))
        touch()
        pruneQuietly()
    }
}
