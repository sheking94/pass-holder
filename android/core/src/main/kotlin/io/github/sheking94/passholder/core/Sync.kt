package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable

/** An entry as this device keeps it (decrypted in memory, encrypted with the vault key on disk). */
@Serializable
data class LocalEntry(
    val id: String,
    /** Server revision this device last saw, 0 if the entry never reached the server. */
    val revision: Long,
    /** Changed here since the last sync. */
    val dirty: Boolean,
    /** Milliseconds since the Unix epoch, set by the device that made the change. Decides sync conflicts. */
    val modifiedAt: Long,
    /** Null for a deleted entry (tombstone). */
    val credentials: Credentials?,
) {
    val deleted: Boolean get() = credentials == null
}

/** An entry that is not deleted. [credentials] is never null here, unlike in [LocalEntry]. */
data class LiveEntry(val id: String, val dirty: Boolean, val credentials: Credentials)

@Serializable
class LocalVault(
    var lastSyncRevision: Long = 0,
    val entries: MutableMap<String, LocalEntry> = linkedMapOf(),
) {
    fun upsert(id: String, credentials: Credentials, now: Long = System.currentTimeMillis()) {
        val revision = entries[id]?.revision ?: 0
        entries[id] = LocalEntry(id, revision, dirty = true, modifiedAt = now, credentials = credentials)
    }

    fun delete(id: String, now: Long = System.currentTimeMillis()) {
        val existing = entries[id] ?: return
        if (existing.revision == 0L) {
            // Never reached the server, nothing to tell it.
            entries.remove(id)
            return
        }
        entries[id] = existing.copy(dirty = true, modifiedAt = now, credentials = null)
    }

    fun liveEntry(id: String): LiveEntry? = entries[id]?.toLiveEntry()

    private fun LocalEntry.toLiveEntry(): LiveEntry? = credentials?.let { LiveEntry(id, dirty, it) }

    fun liveEntries(): List<LiveEntry> = entries.values.mapNotNull { it.toLiveEntry() }

    fun pendingCount(): Int = entries.values.count { it.dirty }
}

/** Client side of docs/SPEC.md §5, same as core/src/sync.ts. */
object VaultSync {
    fun buildRequest(vault: LocalVault, vaultKey: ByteArray) = SyncRequest(
        sinceRevision = vault.lastSyncRevision,
        changes = vault.entries.values.filter { it.dirty }.map {
            ChangeRequest(it.id, it.revision, it.deleted, VaultCrypto.encryptEntry(vaultKey, it))
        },
    )

    /**
     * Applies the server's answer. Conflicts are resolved by last write wins on modifiedAt; on a tie the
     * server's version wins, so every device reaches the same result.
     *
     * Last write wins applies to every record, not only to local changes: a remote version older than the
     * local one is refused and the local one is pushed again, so a server cannot roll an entry back to an
     * old ciphertext (S2 of the security review, same as core/src/sync.ts).
     *
     * Everything is decrypted and checked before anything changes, so a bad record leaves the vault as it was.
     * Returns true when a local version won and must be pushed again.
     */
    fun applyResponse(vault: LocalVault, response: SyncResponse, vaultKey: ByteArray): Boolean {
        val remotes = (response.conflicts + response.changes).map { VaultCrypto.decryptRecord(vaultKey, it) }
        for ((id, revision) in response.accepted) {
            vault.entries[id]?.let { vault.entries[id] = it.copy(revision = revision, dirty = false) }
        }
        var needsResync = false
        for (remote in remotes) {
            val local = vault.entries[remote.id]
            if (local != null && local.modifiedAt > remote.modifiedAt) {
                vault.entries[remote.id] = local.copy(revision = remote.revision, dirty = true)
                needsResync = true
            } else {
                vault.entries[remote.id] = remote
            }
        }
        vault.lastSyncRevision = response.currentRevision
        return needsResync
    }

    /** Full sync: push local changes, pull remote ones, repeat while local changes win conflicts. */
    fun sync(vault: LocalVault, vaultKey: ByteArray, maxRounds: Int = 3, send: (SyncRequest) -> SyncResponse) {
        repeat(maxRounds) {
            val response = send(buildRequest(vault, vaultKey))
            if (!applyResponse(vault, response, vaultKey)) return
        }
        throw IllegalStateException("Synchronizacja się nie ustabilizowała, spróbuj ponownie")
    }
}
