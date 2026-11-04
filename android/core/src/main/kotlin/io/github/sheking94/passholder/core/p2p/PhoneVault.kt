package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Credentials
import io.github.sheking94.passholder.core.RemoteRecord

data class PhoneEntry(val id: String, val revision: Long, val credentials: Credentials, val hlc: Hlc)

/** The phone's own edits to its vault, written straight into the store with HLC stamps. */
class PhoneVault(
    private val store: SyncStore,
    private val vaultKey: ByteArray,
    deviceId: String,
    now: () -> Long = System::currentTimeMillis,
) {
    private val clock = HlcClock(deviceId, now)

    init {
        synchronized(store) {
            for (r in store.listSince(0)) read(r)?.let(clock::observe)
        }
    }

    fun upsert(id: String, credentials: Credentials) {
        synchronized(store) {
            store.get(id)?.let { old -> read(old)?.let(clock::observe) }
            val hlc = clock.tick()
            val blob = EntryV2.encrypt(
                vaultKey, id, EntryDataV2(credentials.name, credentials.username, credentials.password, hlc),
            )
            store.put(RemoteRecord(id, store.currentRevision() + 1, false, blob))
        }
    }

    /** Writes a tombstone; an unknown id is ignored. */
    fun delete(id: String) {
        synchronized(store) {
            val old = store.get(id) ?: return
            read(old)?.let(clock::observe)
            val blob = EntryV2.encryptTombstone(vaultKey, id, TombstoneDataV2(clock.tick()))
            store.put(RemoteRecord(id, store.currentRevision() + 1, true, blob))
        }
    }

    /** Live entries sorted by name; unreadable records are skipped (see [unreadableIds]). */
    fun entries(): List<PhoneEntry> = synchronized(store) {
        store.listSince(0).filter { !it.deleted }.mapNotNull { r ->
            readEntry(r)?.let { PhoneEntry(r.id, r.revision, Credentials(it.name, it.username, it.password), it.hlc) }
        }.sortedBy { it.credentials.name }
    }

    fun unreadableIds(): List<String> = synchronized(store) {
        store.listSince(0).filter { read(it) == null }.map { it.id }
    }

    private fun readEntry(r: RemoteRecord): EntryDataV2? = try {
        EntryV2.parseEntry(EntryV2.decrypt(vaultKey, r.id, r.blob))
    } catch (e: Exception) {
        null
    }

    /** HLC of a readable entry or tombstone, null when the record cannot be decrypted or parsed. */
    private fun read(r: RemoteRecord): Hlc? = try {
        val json = EntryV2.decrypt(vaultKey, r.id, r.blob)
        if (r.deleted) EntryV2.parseTombstone(json).hlc else EntryV2.parseEntry(json).hlc
    } catch (e: Exception) {
        null
    }
}
