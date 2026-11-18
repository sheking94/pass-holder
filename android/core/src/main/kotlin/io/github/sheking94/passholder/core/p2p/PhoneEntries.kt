package io.github.sheking94.passholder.core.p2p

/**
 * The vault's entries for the app. Each method takes the vault lock, needs the unlocked vault
 * ([io.github.sheking94.passholder.core.ErrorCode.VAULT_LOCKED] otherwise) and counts as activity, except the reads
 * of the list. Writes are followed by [PhoneFiles.pruneQuietly].
 */
internal class PhoneEntries(private val vaultLock: Any, private val session: PhoneSession, private val files: PhoneFiles) {
    fun list(): List<PhoneEntry> = synchronized(vaultLock) { session.require().vault.entries() }

    fun get(id: String): PhoneEntry? = list().firstOrNull { it.id == id }

    fun upsert(id: String, content: EntryContent) = synchronized(vaultLock) {
        session.require().vault.upsertContent(id, content)
        session.touch()
        files.pruneQuietly()
    }

    fun import(entries: List<EntryContent>): ImportResult = synchronized(vaultLock) {
        val result = session.require().vault.importContents(entries)
        session.touch()
        result
    }

    fun allContents(): List<EntryContent> = synchronized(vaultLock) {
        val result = session.require().vault.entries().map { it.content }
        session.touch()
        result
    }

    fun delete(id: String) = synchronized(vaultLock) {
        session.require().vault.delete(id)
        session.touch()
        files.pruneQuietly()
    }

    fun unreadableIds(): List<String> = synchronized(vaultLock) { session.require().vault.unreadableIds() }
}
