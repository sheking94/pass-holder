package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.PassHolderException
import io.github.sheking94.passholder.core.checkCode
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.FileChunk
import io.github.sheking94.passholder.core.files.FileChunks
import io.github.sheking94.passholder.core.files.FileHost

/**
 * The vault's files on the phone: adding, reading and deleting the ones no entry uses. Every method that needs the
 * unlocked vault takes [vaultLock] itself. [prune] and [discard] list the used files under [vaultLock], then delete
 * under the store's monitor only, after checking that no reset closed the store in between.
 */
internal class PhoneFiles(
    private val vaultLock: Any,
    private val session: PhoneSession,
    private val storage: HostStorage,
    private val now: () -> Long,
    private val onError: (Throwable) -> Unit,
) {
    /** Encrypts and stores a complete file; see [PhoneVaultStore.addFile]. */
    fun add(bytes: ByteArray, name: String, mime: String): Attachment = synchronized(vaultLock) {
        session.require()
        val encrypted = FileChunks.encrypt(bytes, name, mime)
        val attachment = encrypted.attachment
        val store = storage.files()
        synchronized(store) {
            checkCode(store.canStore(encrypted.blobs.sumOf { it.length.toLong() }), ErrorCode.NO_SPACE)
            val at = now()
            encrypted.blobs.forEachIndexed { i, blob -> store.put(FileChunk(attachment.id, i, attachment.chunks, blob), at) }
        }
        session.touch()
        attachment
    }

    fun isComplete(a: Attachment): Boolean = synchronized(vaultLock) {
        session.require()
        val store = storage.files()
        synchronized(store) { store.chunks(a.id) == a.chunks && store.have(a.id).size == a.chunks }
    }

    /** [ErrorCode.FILE_CORRUPTED] when a chunk is missing or does not match. */
    fun read(a: Attachment): ByteArray = synchronized(vaultLock) {
        session.require()
        val store = storage.files()
        val blobs = synchronized(store) {
            if (store.chunks(a.id) != a.chunks) throw PassHolderException(ErrorCode.FILE_CORRUPTED)
            (0 until a.chunks).map { store.get(a.id, it) ?: throw PassHolderException(ErrorCode.FILE_CORRUPTED) }
        }
        session.touch()
        FileChunks.decrypt(a, blobs)
    }

    /** See [PhoneVaultStore.pruneFiles]. */
    fun prune(): Int {
        val (used, store) = synchronized(vaultLock) {
            val vault = session.require().vault
            val store = storage.files()
            if (synchronized(store) { store.ids().isEmpty() }) return 0
            if (vault.unreadableIds().isNotEmpty()) return 0
            usedIds(vault) to store
        }
        return synchronized(store) {
            // A reset since the entries were listed: the old files are gone already.
            if (store.closed) return 0
            val orphans = FileHost.orphanIds(store, used, now())
            orphans.forEach(store::delete)
            orphans.size
        }
    }

    /** See [PhoneVaultStore.discardFiles]. */
    fun discard(ids: Collection<String>): Int {
        val (used, store) = synchronized(vaultLock) {
            val vault = session.require().vault
            val store = storage.files()
            if (vault.unreadableIds().isNotEmpty()) return 0
            usedIds(vault) to store
        }
        return synchronized(store) {
            // A reset since the entries were listed: the old files are gone already.
            if (store.closed) return 0
            val present = store.ids()
            val doomed = ids.toSet().filter { it !in used && it in present }
            doomed.forEach(store::delete)
            doomed.size
        }
    }

    /**
     * Deletes files an archive import just added, while no entry was written with them; works while locked (the
     * vault may have locked mid-import). The ids are fresh random UUIDs nothing else refers to.
     */
    fun dropNew(ids: List<String>) {
        if (ids.isEmpty()) return
        quietly {
            val store = storage.files()
            synchronized(store) {
                if (!store.closed) ids.forEach(store::delete)
            }
        }
    }

    /** [prune] after unlocking or an entry write: a failure must not fail that, it only goes to [onError]. */
    fun pruneQuietly() = quietly { prune() }

    /** Ids of the files live entries use. Caller holds [vaultLock]. */
    fun usedIds(vault: PhoneVault = session.require().vault): Set<String> =
        vault.entries().flatMapTo(HashSet()) { e -> e.content.attachments.map { it.id } }

    private fun quietly(block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            reportError(onError, e)
        }
    }
}
