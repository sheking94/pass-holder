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

    fun liveEntries(): List<LocalEntry> = entries.values.filter { !it.deleted }

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
     * Returns true when a local change won a conflict and must be pushed again.
     */
    fun applyResponse(vault: LocalVault, response: SyncResponse, vaultKey: ByteArray): Boolean {
        for ((id, revision) in response.accepted) {
            vault.entries[id]?.let { vault.entries[id] = it.copy(revision = revision, dirty = false) }
        }
        var needsResync = false
        for (record in response.conflicts + response.changes) {
            val remote = VaultCrypto.decryptRecord(vaultKey, record)
            val local = vault.entries[record.id]
            if (local != null && local.dirty && local.modifiedAt > remote.modifiedAt) {
                vault.entries[record.id] = local.copy(revision = record.revision)
                needsResync = true
            } else {
                vault.entries[record.id] = remote
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
