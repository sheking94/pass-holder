package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.RemoteRecord

/** In-memory store; not thread-safe, callers must hold synchronized(store). */
class MemorySyncStore : SyncStore {
    private val records = HashMap<String, RemoteRecord>()
    private var revision = 0L

    override fun get(id: String): RemoteRecord? = records[id]

    override fun put(record: RemoteRecord) {
        records[record.id] = record
        revision = maxOf(revision, record.revision)
    }

    override fun listSince(revision: Long): List<RemoteRecord> = records.values.filter { it.revision > revision }.sortedBy { it.revision }

    override fun currentRevision(): Long = revision
}
