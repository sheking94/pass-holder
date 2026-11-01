package io.github.sheking94.passholder.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** Edge cases found while testing the whole system; the TypeScript counterparts are in core/test/sync-edge.test.ts and extension/test/edge-cases.test.ts. */
class EdgeCaseTest {
    private val password = "hasło główne"
    private val servers = mutableListOf<MockWebServer>()

    @AfterEach
    fun stop() = servers.forEach { it.shutdown() }

    private fun startServer(): Pair<String, FakeServer> {
        val (server, fake) = FakeServer.start()
        servers += server
        return server.url("/").toString() to fake
    }

    @Test
    fun `logs in again when the server was restarted and forgot the session`() {
        val (url, fake) = startServer()
        val store = VaultStore(MemoryStore())
        store.createVault(listOf(url), null, "token", password)
        store.sync()
        fake.forgetSessions() // the Raspberry Pi was switched off and on, the token has not expired yet
        store.upsert("1", Credentials("bank.pl", "jan", "x"))
        store.sync()
        assertEquals(0, store.pendingCount())
        assertEquals(2, fake.sessionCount)
    }

    @Test
    fun `does not save the account when setup is refused`() {
        val (url, _) = startServer()
        val store = VaultStore(MemoryStore())
        assertThrows<ApiException> { store.createVault(listOf(url), null, "wrong", password) }
        assertNull(store.account())
        assertFalse(store.isUnlocked)
    }

    @Test
    fun `refuses a server that sends weak KDF parameters before deriving anything`() {
        val server = MockWebServer().also { servers += it }
        server.enqueue(
            MockResponse().setHeader("content-type", "application/json")
                .setBody("""{"kdf":{"alg":"argon2id","salt":"AAAAAAAAAAAAAAAAAAAAAA==","memoryKiB":8,"iterations":1,"parallelism":1}}"""),
        )
        server.start()
        val store = VaultStore(MemoryStore())
        assertThrows<IllegalArgumentException> { store.connectExisting(listOf(server.url("/").toString()), null, password) }
        assertNull(store.account())
        assertEquals(1, server.requestCount) // never sent an auth key
    }

    @Test
    fun `refuses an https address without a pin and an unknown scheme`() {
        assertThrows<IllegalArgumentException> { ServerClient("https://pi.local:8443", null) }
        assertThrows<IllegalArgumentException> { ServerClient("ftp://pi.local", null) }
    }

    @Test
    fun `refuses to use the vault while locked`() {
        val store = VaultStore(MemoryStore())
        assertThrows<IllegalStateException> { store.entries() }
        assertThrows<IllegalStateException> { store.upsert("1", Credentials("a", "b", "c")) }
        assertThrows<IllegalStateException> { store.sync() }
        assertThrows<IllegalStateException> { store.unlock(password) }
    }

    @Test
    fun `keeps unsynced changes across lock and unlock`() {
        val (url, _) = startServer()
        val disk = MemoryStore()
        val store = VaultStore(disk)
        store.createVault(listOf(url), null, "token", password)
        store.upsert("1", Credentials("offline.pl", "u", "p"))
        store.lock()
        store.unlock(password)
        assertEquals(1, store.pendingCount())
        store.sync()
        assertEquals(0, store.pendingCount())
    }
}

class SyncEdgeCaseTest {
    private val key = VaultCrypto.newVaultKey()
    private fun creds(password: String) = Credentials("a.com", "u", password)

    @Test
    fun `recovers when the server applied a change but the answer was lost`() {
        val server = MemorySyncServer()
        val phone = LocalVault()
        phone.upsert("1", creds("p"), 100)
        server.process(VaultSync.buildRequest(phone, key)) // answer never arrives
        VaultSync.sync(phone, key) { server.process(it) }
        assertEquals(LocalEntry("1", 1, false, 100, creds("p")), phone.entries["1"])
        assertEquals(1L, server.revision)
    }

    @Test
    fun `a newer deletion beats an older edit and a newer edit beats an older deletion`() {
        val server = MemorySyncServer()
        val phone = LocalVault()
        val browser = LocalVault()
        val sync = { v: LocalVault -> VaultSync.sync(v, key) { server.process(it) } }
        phone.upsert("1", creds("old"), 100)
        phone.upsert("2", creds("old"), 100)
        sync(phone); sync(browser)

        browser.upsert("1", creds("edited"), 200)
        phone.delete("1", 300)
        phone.delete("2", 200)
        browser.upsert("2", creds("edited"), 300)
        sync(browser); sync(phone); sync(browser)

        for (v in listOf(phone, browser)) {
            assertTrue(v.entries["1"]!!.deleted)
            assertEquals(creds("edited"), v.entries["2"]!!.credentials)
        }
    }

    @Test
    fun `refuses a record the server moved to another id`() {
        val server = MemorySyncServer()
        val phone = LocalVault()
        phone.upsert("bank", Credentials("bank.pl", "u", "bank-pass"), 100)
        phone.upsert("mail", Credentials("mail.pl", "u", "mail-pass"), 100)
        VaultSync.sync(phone, key) { server.process(it) }
        server.records["bank"] = server.records["bank"]!!.copy(blob = server.records["mail"]!!.blob)
        val browser = LocalVault()
        assertThrows<Exception> { VaultSync.sync(browser, key) { server.process(it) } }
        assertEquals(0L, browser.lastSyncRevision)
    }

    @Test
    fun `gives up after maxRounds when local changes keep winning`() {
        val phone = LocalVault().apply { upsert("1", creds("mine"), 1_000) }
        val theirs = LocalVault().apply { upsert("1", creds("theirs"), 1) }
        val blob = VaultSync.buildRequest(theirs, key).changes.single().blob
        val stubborn = { _: SyncRequest -> SyncResponse(7, emptyList(), listOf(RemoteRecord("1", 7, false, blob)), emptyList()) }
        assertThrows<IllegalStateException> { VaultSync.sync(phone, key, 3, stubborn) }
        assertEquals(creds("mine"), phone.entries["1"]!!.credentials)
    }
}

class KdfBoundsTest {
    private val ok = Kdf.newParams()

    @Test
    fun `rejects parameters a malicious server could use against the phone`() {
        Kdf.assertAcceptable(ok.copy(memoryKiB = Kdf.MAX_MEMORY_KIB, iterations = Kdf.MAX_ITERATIONS, parallelism = Kdf.MAX_PARALLELISM))
        for (bad in listOf(
            ok.copy(salt = Encoding.toBase64(ByteArray(8))),
            ok.copy(parallelism = 0),
            ok.copy(iterations = Kdf.MAX_ITERATIONS + 1),
            ok.copy(parallelism = Kdf.MAX_PARALLELISM + 1),
        )) {
            assertThrows<IllegalArgumentException> { Kdf.assertAcceptable(bad) }
        }
    }

    @Test
    fun `NFC normalization gives the same key for the same password typed two ways`() {
        val params = ok.copy(memoryKiB = Kdf.MIN_MEMORY_KIB, iterations = Kdf.MIN_ITERATIONS, parallelism = 1)
        val composed = Kdf.deriveKeys("ą", params)
        val decomposed = Kdf.deriveKeys("ą", params)
        assertEquals(Encoding.toHex(composed.authKey), Encoding.toHex(decomposed.authKey))
    }
}
