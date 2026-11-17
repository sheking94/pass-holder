package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.RemoteRecord
import io.github.sheking94.passholder.core.transfer.contentKey
import java.util.UUID

private const val MAX_DEVICE_ID_LENGTH = 64

data class PhoneEntry(val id: String, val revision: Long, val data: EntryDataV3) {
    val content: EntryContentV3 get() = data.content
    val hlc: Hlc get() = data.hlc
}

/** What [PhoneVault.importContents] did. */
data class ImportResult(val added: Int, val duplicates: Int, val tooLarge: Int)

/** An id holds a live entry of another type than the one being written. */
class EntryTypeMismatchException : IllegalArgumentException("Entry has another type")

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
     * Writes any entry content. An id holding a live entry of another type is refused
     * ([EntryTypeMismatchException]); over a tombstone or an unreadable record the type may differ.
     * [EntryTooLargeException] leaves the store as it was.
     */
    fun upsertContent(id: String, content: EntryContentV3) {
        requireValidId(id)
        synchronized(store) {
            val old = store.get(id)?.takeIf { !it.deleted }?.let(::readData)
            if (old != null && old.content.fields.type != content.fields.type) throw EntryTypeMismatchException()
            write(id, content)
        }
    }

    /** Caller holds the store's monitor. */
    private fun write(id: String, content: EntryContentV3) {
        store.get(id)?.let { old -> read(old)?.let(clock::observe) }
        val blob = EntryV3.encrypt(vaultKey, id, EntryDataV3(content, clock.tick()))
        store.put(RemoteRecord(id, store.currentRevision() + 1, false, blob))
    }

    /**
     * Adds [entries] as new entries, all or nothing. One whose [contentKey] matches a live readable entry or an
     * earlier one of the list is a duplicate; one over the size limit is counted in tooLarge. All new records
     * go to the store in one [SyncStore.putAll]; if that throws, nothing was stored.
     */
    fun importContents(entries: List<EntryContentV3>, newId: () -> String = { UUID.randomUUID().toString() }): ImportResult =
        synchronized(store) {
            val records = store.listSince(0)
            for (r in records) read(r)?.let(clock::observe)
            val known = HashSet<String>()
            for (r in records) if (!r.deleted) readData(r)?.let { known.add(contentKey(it.content)) }
            val fresh = ArrayList<RemoteRecord>()
            var tooLarge = 0
            var revision = store.currentRevision()
            for (entry in entries) {
                val key = contentKey(entry)
                if (key in known) continue
                val id = newId()
                requireValidId(id)
                val blob = try {
                    EntryV3.encrypt(vaultKey, id, EntryDataV3(entry, clock.tick()))
                } catch (e: EntryTooLargeException) {
                    tooLarge++
                    continue
                }
                known.add(key)
                fresh.add(RemoteRecord(id, ++revision, false, blob))
            }
            if (fresh.isNotEmpty()) store.putAll(fresh)
            ImportResult(fresh.size, entries.size - fresh.size - tooLarge, tooLarge)
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

    /** Live readable entries of every type sorted by name (see [unreadableIds] for the rest). */
    fun entries(): List<PhoneEntry> = synchronized(store) {
        store.listSince(0).filter { !it.deleted }.mapNotNull { r ->
            readData(r)?.let { PhoneEntry(r.id, r.revision, it) }
        }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.content.name })
    }

    /** Records that cannot be decrypted or parsed. */
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
