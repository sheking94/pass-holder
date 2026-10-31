package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable

// Wire format of POST /api/v1/sync, docs/SPEC.md §5, same as core/src/protocol.ts.

@Serializable
data class RemoteRecord(val id: String, val revision: Long, val deleted: Boolean, val blob: String)

@Serializable
data class ChangeRequest(
    val id: String,
    /** Revision the client last saw for this entry, 0 for a new entry. */
    val baseRevision: Long,
    val deleted: Boolean,
    val blob: String,
)

@Serializable
data class SyncRequest(val sinceRevision: Long, val changes: List<ChangeRequest>)

@Serializable
data class Accepted(val id: String, val revision: Long)

@Serializable
data class SyncResponse(
    val currentRevision: Long,
    val accepted: List<Accepted>,
    /** Server's version of each entry whose baseRevision was out of date. */
    val conflicts: List<RemoteRecord>,
    /** Records changed after sinceRevision, except those in accepted and conflicts. */
    val changes: List<RemoteRecord>,
)
