package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.RemoteRecord

private const val MAX_DEVICE_ID_LENGTH = 64

data class PhoneEntry(val id: String, val revision: Long, val credentials: Credentials, val hlc: Hlc, val data: EntryDataV3)

/** The phone's own edits to its vault, written straight into the store with HLC stamps. */
class PhoneVault(
    private val store: SyncStore,
    private val vaultKey: ByteArray,
    deviceId: String,
    now: () -> Long = System::currentTimeMillis,
) {
    private val clock = HlcClock(deviceId, now)

    init {
        require(deviceId.length in 1..MAX_DEVICE_ID_LENGTH) { "deviceId must be 1..$MAX_DEVICE_ID_LENGTH characters" }
        synchronized(store) {
            for (r in store.listSince(0)) read(r)?.let(clock::observe)
        }
    }

    /**
     * Saves a login edited on the phone: an existing login keeps everything but name, username and password;
     * a new one starts with empty note, URLs and custom fields. An id holding a live entry of another type is
     * refused (IllegalArgumentException) and nothing is written. [EntryTooLargeException] leaves the store as it was.
     */
    fun upsert(id: String, credentials: Credentials) {
        requireValidId(id)
        synchronized(store) {
            val existing = store.get(id)?.takeIf { !it.deleted }?.let(::readData)
            val content = when (val old = existing?.content) {
                null -> EntryContentV3(credentials.name, "", LoginFields(credentials.username, credentials.password), emptyList())
                else -> {
                    val fields = old.fields as? LoginFields ?: throw IllegalArgumentException("Entry is not a login")
                    old.copy(
                        name = credentials.name,
                        fields = fields.copy(username = credentials.username, password = credentials.password),
                    )
                }
            }
            write(id, content)
        }
    }

    /** Writes any entry content (no type check); [EntryTooLargeException] leaves the store as it was. */
    fun upsertContent(id: String, content: EntryContentV3) {
        requireValidId(id)
        synchronized(store) { write(id, content) }
    }

    /** Caller holds the store's monitor. */
    private fun write(id: String, content: EntryContentV3) {
        store.get(id)?.let { old -> read(old)?.let(clock::observe) }
        val blob = EntryV3.encrypt(vaultKey, id, EntryDataV3(content, clock.tick()))
        store.put(RemoteRecord(id, store.currentRevision() + 1, false, blob))
    }

    /** Writes a tombstone; an unknown id is ignored. */
    fun delete(id: String) {
        requireValidId(id)
        synchronized(store) {
            val old = store.get(id) ?: return
            read(old)?.let(clock::observe)
            val blob = EntryV3.encryptTombstone(vaultKey, id, TombstoneData(clock.tick()))
            store.put(RemoteRecord(id, store.currentRevision() + 1, true, blob))
        }
    }

    /** Live logins sorted by name; other types and unreadable records are skipped (see [unreadableIds]). */
    fun entries(): List<PhoneEntry> = synchronized(store) {
        store.listSince(0).filter { !it.deleted }.mapNotNull { r ->
            val data = readData(r) ?: return@mapNotNull null
            val login = data.content.fields as? LoginFields ?: return@mapNotNull null
            PhoneEntry(r.id, r.revision, Credentials(data.content.name, login.username, login.password), data.hlc, data)
        }.sortedBy { it.credentials.name }
    }

    /** Records that cannot be decrypted or parsed; entries of other types are readable, so not listed. */
    fun unreadableIds(): List<String> = synchronized(store) {
        store.listSince(0).filter { read(it) == null }.map { it.id }
    }

    private fun requireValidId(id: String) =
        require(id.length in 1..HostSync.MAX_ENTRY_ID_LENGTH) { "id must be 1..${HostSync.MAX_ENTRY_ID_LENGTH} characters" }

    private fun readData(r: RemoteRecord): EntryDataV3? = try {
        EntryV3.parse(EntryV3.decrypt(vaultKey, r.id, r.blob))
    } catch (e: Exception) {
        null
    }

    /** HLC of a readable entry or tombstone, null when the record cannot be decrypted or parsed. */
    private fun read(r: RemoteRecord): Hlc? = try {
        val json = EntryV3.decrypt(vaultKey, r.id, r.blob)
        if (r.deleted) EntryV3.parseTombstone(json).hlc else EntryV3.parse(json).hlc
    } catch (e: Exception) {
        null
    }
}
