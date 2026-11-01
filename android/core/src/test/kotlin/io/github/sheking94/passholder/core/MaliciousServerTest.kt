package io.github.sheking94.passholder.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * S2 of the security review: a server (or someone who swapped its SQLite file) can change the plain
 * deleted flag and revision numbers, and send back old ciphertexts. Same scenarios as
 * core/test/malicious-server.test.ts.
 */
class MaliciousServerTest {
    private val server = MemorySyncServer()
    private val vaultKey = VaultCrypto.newVaultKey()
    private fun sync(vault: LocalVault) = VaultSync.sync(vault, vaultKey, send = server::process)
    private fun passwords(vault: LocalVault) = vault.liveEntries().map { it.credentials.password }
    private fun creds(password: String) = Credentials("bank.pl", "jan", password)

    /** What the server now holds for the entry, with one more revision, as a compromised Pi would serve it. */
    private fun serve(record: RemoteRecord) {
        server.revision++
        server.records[record.id] = record.copy(revision = server.revision)
    }

    @Test
    fun `cannot delete an entry by setting deleted on its record`() {
        val phone = LocalVault()
        val browser = LocalVault()
        phone.upsert("1", creds("s3cret"), 100)
        sync(phone)

        serve(server.records["1"]!!.copy(deleted = true))
        assertEquals(VaultCrypto.INCONSISTENT_RECORD, assertThrows<IllegalStateException> { sync(phone) }.message)
        assertEquals(VaultCrypto.INCONSISTENT_RECORD, assertThrows<IllegalStateException> { sync(browser) }.message)
        assertEquals(listOf("s3cret"), passwords(phone)) // the local copy is untouched
        assertTrue(browser.entries.isEmpty())
        assertEquals(0L, browser.lastSyncRevision)
    }

    @Test
    fun `cannot turn a tombstone back into an entry by clearing deleted`() {
        val phone = LocalVault()
        phone.upsert("1", creds("s3cret"), 100)
        sync(phone)
        phone.delete("1", 200)
        sync(phone)

        val browser = LocalVault()
        serve(server.records["1"]!!.copy(deleted = false))
        assertThrows<IllegalStateException> { sync(browser) }
    }

    @Test
    fun `cannot roll an entry back to an old ciphertext on a device that has the newer one`() {
        val phone = LocalVault()
        val browser = LocalVault()
        phone.upsert("1", creds("old-password"), 100)
        sync(phone)
        val oldRecord = server.records["1"]!!
        phone.upsert("1", creds("new-password"), 200)
        sync(phone)
        sync(browser)

        serve(oldRecord) // the ciphertext from before the password change, as a fresh revision
        sync(browser)
        sync(phone)
        assertEquals(listOf("new-password"), passwords(browser))
        assertEquals(listOf("new-password"), passwords(phone))
        assertTrue(server.records["1"]!!.revision > oldRecord.revision + 2) // pushed back to the server
    }

    @Test
    fun `reads tombstones and entries written by the TypeScript core`() {
        // Same JSON as JSON.stringify in core/src/vault.ts: {"modifiedAt":5} and the entry fields.
        val tombstone = Aead.seal(vaultKey, Encoding.utf8("""{"modifiedAt":5}"""), VaultCrypto.entryAad("t"))
        val entry = Aead.seal(vaultKey, Encoding.utf8("""{"name":"a","username":"b","password":"c","modifiedAt":6}"""), VaultCrypto.entryAad("e"))
        assertTrue(VaultCrypto.decryptRecord(vaultKey, RemoteRecord("t", 1, true, tombstone)).deleted)
        assertEquals("c", VaultCrypto.decryptRecord(vaultKey, RemoteRecord("e", 2, false, entry)).credentials!!.password)
    }
}
