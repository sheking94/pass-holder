package io.github.sheking94.passholder.core

import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File

/** The phone's VaultStore against a fake server over plain HTTP (TLS is covered in CertificatePinTest). */
class VaultStoreTest {
    private val password = "Zażółć gęślą jaźń 2026"
    private val servers = mutableListOf<MockWebServer>()

    @AfterEach
    fun stop() = servers.forEach { it.shutdown() }

    private fun startServer(): Pair<String, FakeServer> {
        val (server, fake) = FakeServer.start()
        servers += server
        return server.url("/").toString() to fake
    }

    private fun names(store: VaultStore) = store.entries().map { it.credentials.name }

    @Test
    fun `creates a vault, syncs, and a second phone downloads it`() {
        val (url, _) = startServer()
        val first = VaultStore(MemoryStore())
        first.createVault(url, null, "token", password)
        first.upsert("1", Credentials("bank.pl", "jan", "s3cret"))
        assertEquals(1, first.pendingCount())
        first.sync()
        assertEquals(0, first.pendingCount())

        val second = VaultStore(MemoryStore())
        second.connectExisting(url, null, password)
        assertEquals(listOf("bank.pl"), names(second))

        second.delete("1")
        second.sync()
        first.sync()
        assertEquals(emptyList<String>(), names(first))
    }

    @Test
    fun `reports a wrong master password, a wrong setup token and an existing vault in Polish`() {
        val (url, _) = startServer()
        assertEquals("Zły token z logu serwera", assertThrows<ApiException> { VaultStore(MemoryStore()).createVault(url, null, "nope", password) }.message)
        VaultStore(MemoryStore()).createVault(url, null, "token", password)
        assertEquals("Złe hasło główne", assertThrows<ApiException> { VaultStore(MemoryStore()).connectExisting(url, null, "wrong") }.message)
        assertTrue(assertThrows<ApiException> { VaultStore(MemoryStore()).createVault(url, null, "token", password) }.message!!.startsWith("Na serwerze już jest sejf"))
    }

    @Test
    fun `unlocks from disk without the server and keeps entries encrypted at rest`(@TempDir dir: File) {
        val (url, _) = startServer()
        val store = VaultStore(FileStore(dir))
        store.createVault(url, null, "token", password)
        store.upsert("1", Credentials("poczta.pl", "jan", "hunter2"))
        servers.removeAt(0).shutdown() // the Raspberry Pi is switched off

        // A new process: nothing in memory, only files.
        val reopened = VaultStore(FileStore(dir))
        assertFalse(reopened.isUnlocked)
        assertEquals("Złe hasło główne", assertThrows<IllegalArgumentException> { reopened.unlock("wrong") }.message)
        reopened.unlock(password)
        assertEquals(listOf("poczta.pl"), names(reopened))

        val onDisk = dir.listFiles()!!.joinToString { it.readText() }
        assertFalse(onDisk.contains("poczta") || onDisk.contains("hunter2"))
        assertEquals(0, assertThrows<ApiException> { reopened.sync() }.status)
    }

    @Test
    fun `locks after 15 minutes without activity`() {
        val (url, _) = startServer()
        var clock = 1_000_000L
        val store = VaultStore(MemoryStore(), now = { clock })
        store.createVault(url, null, "token", password)

        clock += VaultStore.AUTO_LOCK_MS - 1
        assertFalse(store.lockIfIdle())
        store.touch()
        clock += VaultStore.AUTO_LOCK_MS - 1
        assertFalse(store.lockIfIdle())
        clock += 1
        assertTrue(store.lockIfIdle())
        assertThrows<IllegalStateException> { store.entries() }
    }

    @Test
    fun `reuses the session token and logs in again when it expires`() {
        val (url, fake) = startServer()
        var clock = System.currentTimeMillis()
        val store = VaultStore(MemoryStore(), now = { clock })
        store.createVault(url, null, "token", password)
        store.sync()
        store.sync()
        assertEquals(1, fake.sessionCount)
        clock += 15 * 60_000
        store.sync()
        assertEquals(2, fake.sessionCount)
    }

    @Test
    fun `disconnect forgets the account and the local copy`(@TempDir dir: File) {
        val (url, _) = startServer()
        val store = VaultStore(FileStore(dir))
        store.createVault(url, null, "token", password)
        store.disconnect()
        assertEquals(null, store.account())
        assertEquals(0, dir.listFiles()!!.size)
    }

    @Test
    fun `unlocks with exported keys after a restart and rejects wrong keys`(@TempDir dir: File) {
        val (url, _) = startServer()
        val store = VaultStore(FileStore(dir))
        store.createVault(url, null, "token", password)
        store.upsert("1", Credentials("poczta.pl", "jan", "hunter2"))
        val keys = store.exportUnlockKeys()
        assertEquals(64, keys.size)

        val reopened = VaultStore(FileStore(dir))
        assertThrows<IllegalArgumentException> { reopened.unlockWithKeys(ByteArray(64)) }
        assertThrows<IllegalArgumentException> { reopened.unlockWithKeys(ByteArray(10)) }
        assertFalse(reopened.isUnlocked)

        reopened.unlockWithKeys(keys)
        assertEquals(listOf("poczta.pl"), names(reopened))
        // The auth key came along too, so syncing works without the master password.
        reopened.sync()
        assertEquals(0, reopened.pendingCount())
    }

    @Test
    fun `exporting keys needs an unlocked vault`() {
        val (url, _) = startServer()
        val store = VaultStore(MemoryStore())
        store.createVault(url, null, "token", password)
        store.lock()
        assertThrows<IllegalStateException> { store.exportUnlockKeys() }
    }
}
