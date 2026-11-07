package io.github.sheking94.passholder.core

import kotlinx.serialization.Serializable

// Records and revisions the phone (the host) keeps, same as core/src/protocol.ts. The P2P protocol in p2p/HostSync.kt builds on them.

@Serializable
data class RemoteRecord(val id: String, val revision: Long, val deleted: Boolean, val blob: String)

@Serializable
data class ChangeRequest(
    val id: String,
    /** Revision the device last saw for this entry, 0 for a new entry. */
    val baseRevision: Long,
    val deleted: Boolean,
    val blob: String,
)

@Serializable
data class Accepted(val id: String, val revision: Long)

@Serializable
data class SyncResponse(
    val currentRevision: Long,
    val accepted: List<Accepted>,
    /** Host's version of each entry whose baseRevision was out of date. */
    val conflicts: List<RemoteRecord>,
    /** Records changed after sinceRevision, except those in accepted and conflicts. */
    val changes: List<RemoteRecord>,
)
