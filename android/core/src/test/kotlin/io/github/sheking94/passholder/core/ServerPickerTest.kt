package io.github.sheking94.passholder.core

import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.ServerSocket
import java.net.Socket

/** Several addresses of one server (home network and Tailscale), see ServerPicker. */
class ServerPickerTest {
    private val password = "Zażółć gęślą jaźń 2026"
    private val closers = mutableListOf<() -> Unit>()

    @AfterEach
    fun stop() = closers.forEach { it() }

    /** The same fake server (same data) answering at two addresses, like the Pi on the LAN and on Tailscale. */
    private fun oneServerTwoAddresses(): Triple<String, String, FakeServer> {
        val fake = FakeServer()
        val (home, _) = FakeServer.start(fake)
        val (tailscale, _) = FakeServer.start(fake)
        closers += { home.shutdown() }
        closers += { tailscale.shutdown() }
        return Triple(home.url("/").toString(), tailscale.url("/").toString(), fake)
    }

    /** A port where nothing listens: the Tailscale address with the VPN off. */
    private fun deadUrl(): String = "http://127.0.0.1:${ServerSocket(0).use { it.localPort }}"

    /** Accepts connections and never answers: an address that leads somewhere silent. */
    private fun silentUrl(): String {
        val socket = ServerSocket(0)
        val accepted = mutableListOf<Socket>()
        Thread { runCatching { while (true) accepted += socket.accept() } }.apply { isDaemon = true }.start()
        closers += { accepted.forEach { it.close() }; socket.close() }
        return "http://127.0.0.1:${socket.localPort}"
    }

    @Test
    fun `normalizes, validates and orders the addresses`() {
        assertEquals(listOf("https://a:1", "https://b:2"), ServerPicker.normalize(listOf(" https://a:1/ ", "", "https://b:2", "https://a:1")))
        assertEquals(listOf("b", "a", "c"), ServerPicker.order(listOf("a", "b", "c"), "b"))
        assertEquals(listOf("a", "b"), ServerPicker.order(listOf("a", "b"), "gone"))
        assertThrows<IllegalArgumentException> { ServerPicker.validate(listOf(" ", ""), https = true) }
        assertThrows<IllegalArgumentException> { ServerPicker.validate(listOf("https://pi:8443", "http://pi:8080"), https = true) }
        assertThrows<IllegalArgumentException> { ServerPicker.validate(listOf("100.64.0.1:8443"), https = true) }
        assertEquals(listOf("https://pi:8443"), ServerPicker.validate(listOf("https://pi:8443/"), https = true))
    }

    @Test
    fun `skips an address that does not answer in time`() {
        val (home, _, _) = oneServerTwoAddresses()
        val started = System.currentTimeMillis()
        val (url, _) = ServerPicker.pick(listOf(silentUrl(), home), null) { ServerClient(it, null) }
        assertEquals(home, url)
        assertTrue(System.currentTimeMillis() - started < 3 * ServerPicker.PROBE_TIMEOUT_MS)
    }

    @Test
    fun `says which addresses it tried when none answers`() {
        val a = deadUrl()
        val b = deadUrl()
        val error = assertThrows<ApiException> { ServerPicker.pick(listOf(a, b), null) { ServerClient(it, null) } }
        assertEquals(0, error.status)
        assertTrue(error.message!!.contains("$a, $b"))
    }

    @Test
    fun `pairs at home and later syncs through the other address`() {
        val (home, tailscale, fake) = oneServerTwoAddresses()
        val offline = deadUrl()
        val used = mutableListOf<String>()
        val phone = VaultStore(MemoryStore(), makeClient = { url, pin -> used += url; ServerClient(url, pin) })

        // Paired at home, with the Tailscale address not reachable yet (VPN off).
        phone.createVault(listOf(home, offline), null, "token", password)
        assertEquals(listOf(home.trimEnd('/'), offline), phone.account()!!.serverUrls)
        assertEquals(home.trimEnd('/'), phone.account()!!.lastServerUrl)

        // Away from home: the home address is gone, the other one works.
        phone.setServerUrls(listOf(offline, tailscale))
        phone.upsert("1", Credentials("bank.pl", "jan", "s3cret"))
        phone.sync()
        assertEquals(0, phone.pendingCount())
        assertEquals(1, fake.sync.records.size)
        assertEquals(tailscale.trimEnd('/'), phone.account()!!.lastServerUrl)

        // The next sync starts with the address that worked last time.
        used.clear()
        phone.sync()
        assertEquals(tailscale.trimEnd('/'), used.first())

        // A second phone paired only at home sees the entry.
        val second = VaultStore(MemoryStore())
        second.connectExisting(home, null, password)
        assertEquals(listOf("bank.pl"), second.entries().map { it.credentials.name })
    }

    @Test
    fun `reads an account saved by version 1_0 with a single serverUrl`() {
        val (home, _, _) = oneServerTwoAddresses()
        val disk = MemoryStore()
        VaultStore(disk).createVault(home, null, "token", password)
        // What 1.0 wrote: "serverUrl" instead of "serverUrls", no "lastServerUrl".
        val old = disk.data["account"]!!
            .replace(Regex(""""serverUrls":\["([^"]+)"\]"""), """"serverUrl":"$1"""")
            .replace(Regex(""","lastServerUrl":"[^"]+""""), "")
        assertFalse(old.contains("serverUrls"))
        disk.data["account"] = old

        val upgraded = VaultStore(disk)
        assertEquals(listOf(home.trimEnd('/')), upgraded.account()!!.serverUrls)
        upgraded.unlock(password)
        upgraded.sync()
        assertTrue(disk.data["account"]!!.contains("serverUrls"))
    }

    @Test
    fun `keeps the https scheme of a paired server`() {
        val disk = MemoryStore()
        val (home, _, _) = oneServerTwoAddresses()
        val phone = VaultStore(disk)
        phone.createVault(home, null, "token", password)
        // Paired without a pin (http development server): https addresses cannot be added, and vice versa.
        assertThrows<IllegalArgumentException> { phone.setServerUrls(listOf("https://100.64.0.1:8443")) }
        assertThrows<IllegalArgumentException> { phone.setServerUrls(emptyList()) }
        assertEquals(listOf(home.trimEnd('/')), phone.account()!!.serverUrls)
    }
}
