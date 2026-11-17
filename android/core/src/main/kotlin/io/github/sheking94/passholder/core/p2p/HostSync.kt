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

/** A decrypted sync request the host refuses; [message] is the error text of the 400 answer. */
class InvalidSyncRequest(message: String) : IllegalArgumentException(message)

/** Host side of P2P sync: validation, epoch check, conflict detection and paging. */
object HostSync {
    const val MAX_CHANGES_PER_REQUEST = 500
    const val MAX_CHANGES_PER_RESPONSE = 500
    const val MAX_ENTRY_ID_LENGTH = 128
    const val MAX_BLOB_BYTES_PER_ROUND = 512 * KIB

    /**
     * Checks the shape of a decrypted sync request and returns it as a typed request (port of parseP2pSyncRequest in
     * host-sync.ts). Built by hand so extra fields are ignored the way the TypeScript host does.
     * Throws [InvalidSyncRequest].
     */
    fun parse(request: JsonElement): P2pSyncRequest {
        if (request !is JsonObject) throw InvalidSyncRequest("malformed sync request")
        val epoch = StrictJson.string(request["epoch"])
        val since = P2pJson.safeLong(request["sinceRevision"])
        val changes = request["changes"] as? JsonArray
        if (epoch == null || since == null || changes == null) throw InvalidSyncRequest("malformed sync request")
        if (changes.size > MAX_CHANGES_PER_REQUEST) throw InvalidSyncRequest("too many changes")
        val ids = HashSet<String>()
        val parsed = changes.map { c ->
            parseChange(c).also { if (!ids.add(it.id)) throw InvalidSyncRequest("duplicate change") }
        }
        return P2pSyncRequest(epoch, since, parsed)
    }

    private fun parseChange(c: JsonElement): ChangeRequest {
        if (c !is JsonObject) throw InvalidSyncRequest("malformed change")
        val id = StrictJson.string(c["id"])
        val baseRevision = P2pJson.safeLong(c["baseRevision"])
        val deleted = StrictJson.boolean(c["deleted"])
        val blob = StrictJson.string(c["blob"])
        if (id == null || id.isEmpty() || id.length > MAX_ENTRY_ID_LENGTH || baseRevision == null || deleted == null || blob == null) {
            throw InvalidSyncRequest("malformed change")
        }
        if (blob.length > EntryCodec.MAX_BLOB_LENGTH) throw InvalidSyncRequest("blob too large")
        return ChangeRequest(id, baseRevision, deleted, blob)
    }

    /**
     * Whether the host processes the request's changes. A request from another epoch, or with sinceRevision ahead of
     * the store (the phone was restored, the client starts over), only learns the epoch and revision.
     */
    private fun isProcessed(store: SyncStore, epoch: String, request: P2pSyncRequest): Boolean =
        request.epoch == epoch && request.sinceRevision <= store.currentRevision()

    /** Every change with a base revision must name a record the store has. Throws [InvalidSyncRequest]. */
    internal fun checkBaseRevisions(store: SyncStore, request: P2pSyncRequest) {
        for (c in request.changes) {
            if (c.baseRevision != 0L && store.get(c.id) == null) throw InvalidSyncRequest("unknown base revision")
        }
    }

    /**
     * Host side of P2P sync: parses the decrypted request (once), checks it against the store and answers.
     * Throws [InvalidSyncRequest] (before any write) when the request is refused.
     */
    fun process(store: SyncStore, epoch: String, addresses: List<String>, request: JsonElement): P2pSyncResponse {
        val parsed = parse(request)
        return synchronized(store) {
            if (!isProcessed(store, epoch, parsed)) {
                return@synchronized P2pSyncResponse(epoch, store.currentRevision(), emptyList(), emptyList(), emptyList(), addresses, false)
            }
            checkBaseRevisions(store, parsed)
            val result = processSync(store, parsed.sinceRevision, parsed.changes)
            val page = pageRecords(result.conflicts, result.changes)
            // Records skipped below this revision were answered in accepted or conflicts, so nothing is lost.
            // Omitted conflicts leave their changes dirty on the client, which sends them again.
            val currentRevision = when {
                !page.more -> result.currentRevision
                page.changes.isNotEmpty() -> page.changes.last().revision
                else -> parsed.sinceRevision
            }
            P2pSyncResponse(epoch, currentRevision, result.accepted, page.conflicts, page.changes, addresses, page.more)
        }
    }

    private class Page(val conflicts: List<RemoteRecord>, val changes: List<RemoteRecord>, val more: Boolean)

    /**
     * Cuts the answer to the round budget: conflicts first, then changes by revision (at most
     * [MAX_CHANGES_PER_RESPONSE]). The first record always goes in, then each one while the running sum of blob
     * characters fits [MAX_BLOB_BYTES_PER_ROUND]. [Page.more] tells whether anything was left out.
     */
    private fun pageRecords(allConflicts: List<RemoteRecord>, allChanges: List<RemoteRecord>): Page {
        val sorted = allChanges.sortedBy { it.revision }
        var budget = MAX_BLOB_BYTES_PER_ROUND
        var included = 0
        fun fits(r: RemoteRecord): Boolean {
            if (included > 0 && r.blob.length > budget) return false
            budget -= r.blob.length
            included++
            return true
        }
        val conflicts = allConflicts.takeWhile(::fits)
        val changes = if (conflicts.size == allConflicts.size) sorted.take(MAX_CHANGES_PER_RESPONSE).takeWhile(::fits) else emptyList()
        return Page(conflicts, changes, more = conflicts.size < allConflicts.size || changes.size < sorted.size)
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
