package io.github.sheking94.passholder.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Same scenarios as core/test/sync.test.ts. */
class SyncTest {
    private val server = MemorySyncServer()
    private val vaultKey = VaultCrypto.newVaultKey()
    private fun sync(vault: LocalVault) = VaultSync.sync(vault, vaultKey, send = server::process)
    private fun names(vault: LocalVault) = vault.liveEntries().map { it.credentials.name }.sorted()
    private fun creds(password: String) = Credentials("a.com", "u", password)

    @Test
    fun `moves entries between two devices`() {
        val phone = LocalVault()
        val browser = LocalVault()
        phone.upsert("1", creds("p"), 100)
        sync(phone)
        sync(browser)
        assertEquals(listOf("a.com"), names(browser))
        assertTrue(phone.entries.values.none { it.dirty })
    }

    @Test
    fun `resolves a conflict by last write wins, on both devices`() {
        val phone = LocalVault()
        val browser = LocalVault()
        phone.upsert("1", creds("old"), 100)
        sync(phone)
        sync(browser)
        phone.upsert("1", creds("phone"), 300)
        browser.upsert("1", creds("browser"), 200)
        sync(browser) // browser's older edit reaches the server first
        sync(phone) // phone's newer edit conflicts and wins
        sync(browser)
        assertEquals("phone", phone.entries["1"]!!.credentials!!.password)
        assertEquals("phone", browser.entries["1"]!!.credentials!!.password)
    }

    @Test
    fun `lets an older local edit lose to a newer remote one`() {
        val phone = LocalVault()
        val browser = LocalVault()
        phone.upsert("1", creds("old"), 100)
        sync(phone)
        sync(browser)
        browser.upsert("1", creds("new"), 300)
        phone.upsert("1", creds("stale"), 200)
        sync(browser)
        sync(phone)
        assertEquals("new", phone.entries["1"]!!.credentials!!.password)
        assertFalse(phone.entries["1"]!!.dirty)
    }

    @Test
    fun `syncs deletions as tombstones`() {
        val phone = LocalVault()
        val browser = LocalVault()
        phone.upsert("1", Credentials("a.com", "u", "p"), 100)
        phone.upsert("2", Credentials("b.com", "u", "p"), 100)
        sync(phone)
        sync(browser)
        browser.delete("1", 200)
        sync(browser)
        sync(phone)
        assertEquals(listOf("b.com"), names(phone))
        assertTrue(server.records["1"]!!.deleted)
    }

    @Test
    fun `drops a never-synced entry locally instead of sending a tombstone`() {
        val vault = LocalVault()
        vault.upsert("1", creds("p"))
        vault.delete("1")
        assertEquals(0, vault.entries.size)
    }

    @Test
    fun `server only ever sees ciphertext`() {
        val phone = LocalVault()
        phone.upsert("1", Credentials("secret-site.com", "me", "hunter2"), 100)
        sync(phone)
        val stored = server.records.values.joinToString()
        assertFalse(stored.contains("secret-site") || stored.contains("hunter2"))
    }
}
