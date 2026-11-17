package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Accepted
import io.github.sheking94.passholder.core.ChangeRequest
import io.github.sheking94.passholder.core.KIB
import io.github.sheking94.passholder.core.RemoteRecord
import io.github.sheking94.passholder.core.StrictJson
import io.github.sheking94.passholder.core.SyncResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Storage the host needs; same contract as SyncStore in core/src/protocol.ts. */
interface SyncStore {
    fun get(id: String): RemoteRecord?
    fun put(record: RemoteRecord)

    /** Stores all [records] or, when it throws, none; a file-backed store writes them in one append. */
    fun putAll(records: List<RemoteRecord>) = records.forEach(::put)

    /** Records with a revision above [revision], ordered by revision. */
    fun listSince(revision: Long): List<RemoteRecord>
    fun currentRevision(): Long
}

@Serializable
data class P2pSyncRequest(val epoch: String, val sinceRevision: Long, val changes: List<ChangeRequest>)

@Serializable
data class P2pSyncResponse(
    val epoch: String,
    /** With more = true: the revision of the last record in changes (sinceRevision when none), so the next sinceRevision continues there. */
    val currentRevision: Long,
    val accepted: List<Accepted>,
    val conflicts: List<RemoteRecord>,
    val changes: List<RemoteRecord>,
    val addresses: List<String>,
    /** True when conflicts or changes were cut (MAX_CHANGES_PER_RESPONSE or MAX_BLOB_BYTES_PER_ROUND) and the client must ask again. */
    val more: Boolean,
)

/** Host side of P2P sync: validation, epoch check, conflict detection and paging. */
object HostSync {
    const val MAX_CHANGES_PER_REQUEST = 500
    const val MAX_CHANGES_PER_RESPONSE = 500
    const val MAX_ENTRY_ID_LENGTH = 128
    const val MAX_BLOB_BYTES_PER_ROUND = 512 * KIB

    /**
     * Checks a decrypted sync request before anything is written. Returns the error text for a 400, or null.
     * Every change is checked against the store first, so a bad change never leaves earlier ones applied.
     */
    fun validate(store: SyncStore, epoch: String, request: JsonElement): String? {
        if (request !is JsonObject) return "malformed sync request"
        val requestEpoch = StrictJson.string(request["epoch"])
        val since = P2pJson.safeLong(request["sinceRevision"])
        val changes = request["changes"] as? JsonArray
        if (requestEpoch == null || since == null || changes == null) return "malformed sync request"
        if (changes.size > MAX_CHANGES_PER_REQUEST) return "too many changes"
        val ids = HashSet<String>()
        for (c in changes) {
            if (c !is JsonObject) return "malformed change"
            val id = StrictJson.string(c["id"])
            if (id == null || id.isEmpty() || id.length > MAX_ENTRY_ID_LENGTH ||
                P2pJson.safeLong(c["baseRevision"]) == null ||
                StrictJson.boolean(c["deleted"]) == null || StrictJson.string(c["blob"]) == null
            ) {
                return "malformed change"
            }
            if (StrictJson.string(c["blob"])!!.length > EntryCodec.MAX_BLOB_LENGTH) return "blob too large"
            if (!ids.add(id)) return "duplicate change"
        }
        // A request from another epoch is not processed, so its base revisions do not matter.
        if (requestEpoch != epoch) return null
        // A client ahead of this store sees a restored phone and starts over; its changes are not processed either.
        if (since > store.currentRevision()) return null
        for (c in changes) {
            c as JsonObject
            val id = StrictJson.string(c["id"])!!
            if (P2pJson.safeLong(c["baseRevision"]) != 0L && store.get(id) == null) {
                return "unknown base revision"
            }
        }
        return null
    }

    /**
     * Host side of P2P sync. A request from another epoch, or with sinceRevision ahead of the store, is not processed:
     * the client only learns the epoch and revision.
     * Throws IllegalArgumentException (before any write) when [validate] rejects the request.
     */
    fun process(store: SyncStore, epoch: String, addresses: List<String>, request: JsonElement): P2pSyncResponse = synchronized(store) {
        validate(store, epoch, request)?.let { throw IllegalArgumentException(it) }
        // Validated, so the shape is known; built by hand to ignore extra fields the way the TypeScript host does.
        val obj = request as JsonObject
        val parsed = P2pSyncRequest(
            epoch = StrictJson.string(obj["epoch"])!!,
            sinceRevision = P2pJson.safeLong(obj["sinceRevision"])!!,
            changes = (obj["changes"] as JsonArray).map { c ->
                c as JsonObject
                ChangeRequest(
                    id = StrictJson.string(c["id"])!!,
                    baseRevision = P2pJson.safeLong(c["baseRevision"])!!,
                    deleted = StrictJson.boolean(c["deleted"])!!,
                    blob = StrictJson.string(c["blob"])!!,
                )
            },
        )
        if (parsed.epoch != epoch || parsed.sinceRevision > store.currentRevision()) {
            return@synchronized P2pSyncResponse(
                epoch,
                store.currentRevision(),
                emptyList(),
                emptyList(),
                emptyList(),
                addresses,
                false,
            )
        }
        val result = processSync(store, parsed.sinceRevision, parsed.changes)
        val sorted = result.changes.sortedBy { it.revision }
        // Conflicts first, then changes; the first record always goes in, then while the running sum fits.
        var budget = MAX_BLOB_BYTES_PER_ROUND
        var included = 0
        fun fits(r: RemoteRecord): Boolean {
            if (included > 0 && r.blob.length > budget) return false
            budget -= r.blob.length
            included++
            return true
        }
        val conflicts = ArrayList<RemoteRecord>()
        for (r in result.conflicts) {
            if (!fits(r)) break
            conflicts.add(r)
        }
        val page = ArrayList<RemoteRecord>()
        if (conflicts.size == result.conflicts.size) {
            for (r in sorted) {
                if (page.size >= MAX_CHANGES_PER_RESPONSE || !fits(r)) break
                page.add(r)
            }
        }
        if (conflicts.size == result.conflicts.size && page.size == sorted.size) {
            return@synchronized P2pSyncResponse(
                epoch,
                result.currentRevision,
                result.accepted,
                conflicts,
                page,
                addresses,
                false,
            )
        }
        // Records skipped below this revision were answered in accepted or conflicts, so nothing is lost.
        // Omitted conflicts leave their changes dirty on the client, which sends them again.
        val currentRevision = if (page.isNotEmpty()) page.last().revision else parsed.sinceRevision
        P2pSyncResponse(epoch, currentRevision, result.accepted, conflicts, page, addresses, true)
    }

    /** Host-side sync logic (port of processSync in core/src/protocol.ts); the host never reads entries. */
    internal fun processSync(store: SyncStore, sinceRevision: Long, changes: List<ChangeRequest>): SyncResponse {
        val accepted = ArrayList<Accepted>()
        val conflicts = ArrayList<RemoteRecord>()
        val handled = HashSet<String>()
        for (change in changes) {
            require(handled.add(change.id)) { "Duplicate change for ${change.id}" }
            val existing = store.get(change.id)
            if ((existing?.revision ?: 0L) != change.baseRevision) {
                requireNotNull(existing) { "Unknown base revision for ${change.id}" }
                conflicts.add(existing)
                continue
            }
            val revision = store.currentRevision() + 1
            store.put(RemoteRecord(change.id, revision, change.deleted, change.blob))
            accepted.add(Accepted(change.id, revision))
        }
        val listed = store.listSince(sinceRevision).filter { it.id !in handled }
        return SyncResponse(store.currentRevision(), accepted, conflicts, listed)
    }
}
