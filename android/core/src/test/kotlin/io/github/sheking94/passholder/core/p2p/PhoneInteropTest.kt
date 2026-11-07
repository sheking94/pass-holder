package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Credentials
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The extension's real TypeScript pairing client and sync client against the real phone host
 * (PhoneVaultStore behind SyncHttpServer, over HTTP on 127.0.0.1).
 * Opt-in because it needs Node.js: PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test
 */
class PhoneInteropTest {
    private val root = File(System.getProperty("passholder.repoRoot"))
    private val servers = ArrayList<SyncHttpServer>()
    private val password = "zażółć 😀"
    private val addresses = listOf("http://192.168.1.5:8787")

    @AfterEach
    fun stop() = servers.forEach { it.stop() }

    /** Starts the phone's HTTP server on a free port; returns its base URL (Host must be an IPv4 literal). */
    private fun serve(store: PhoneVaultStore): String {
        val server = SyncHttpServer(0, store.router({}) { addresses }::handle)
        servers.add(server)
        return "http://127.0.0.1:${server.start()}"
    }

    /** Runs the TypeScript client and returns the JSON it prints on its last line. */
    private fun runClient(baseUrl: String, code: String, restore: Boolean, count: Int, prefix: String, tmp: File): JsonObject {
        val config = File(tmp, "config.json")
        config.writeText(
            buildJsonObject {
                put("code", code)
                put("password", password)
                put("restore", restore)
                put("count", count)
                put("prefix", prefix)
            }.toString(),
            Charsets.UTF_8,
        )
        // No --experimental-transform-types: the script and core/src need only type stripping.
        val process = ProcessBuilder(
            "node", "--disable-warning=ExperimentalWarning",
            "android/core/src/test/resources/phone-interop.ts",
            root.path, baseUrl, config.path,
        ).directory(root).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader(Charsets.UTF_8).readText()
        check(process.waitFor(5, TimeUnit.MINUTES) && process.exitValue() == 0) { "node client failed:\n$output" }
        return Json.parseToJsonElement(output.trim().lines().last()).jsonObject
    }

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content

    private fun JsonObject.names() = getValue("names").jsonArray.map { it.jsonPrimitive.content }

    @Test
    fun `extension pairs with the phone and they exchange entries`(@TempDir tmp: File) {
        assumeTrue(System.getenv("PASSHOLDER_INTEROP_TEST") == "1", "set PASSHOLDER_INTEROP_TEST=1")
        val store = PhoneVaultStore(File(tmp, "phone"), PlainSecretWrapper)
        store.createVault(password)
        store.upsert("phone-1", Credentials("z-telefonu.pl", "jan", "z Kotlina"))
        val baseUrl = serve(store)
        val offer = store.offerPairing()
        assertEquals(PairingMode.PAIR, offer.mode)

        val out = runClient(baseUrl, offer.code, restore = false, count = 2, prefix = "z-przegladarki", tmp = tmp)

        assertEquals("pair", out.str("mode"))
        val phone = out.getValue("phone").jsonObject
        assertEquals(PhoneVaultStore.DEFAULT_DEVICE_NAME, phone.str("name"))
        val info = out.getValue("vaultInfo").jsonObject
        assertEquals(addresses, info.getValue("addresses").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(info.str("epoch"), out.str("epoch"))
        // The extension unwrapped the phone's vault key, so it reads the phone's entry and the phone reads its own.
        assertEquals(listOf("z-przegladarki-0", "z-przegladarki-1", "z-telefonu.pl"), out.names())
        val device = store.devices().single()
        assertEquals(out.str("deviceId"), device.deviceId)
        assertEquals("Chrome", device.name)
        // The extension writes v3 entries; the phone vault reads only v2 until the phone app moves to v3, so the two
        // entries from the browser are stored but unreadable for now.
        assertEquals(listOf("z-telefonu.pl"), store.entries().map { it.credentials.name })
        assertEquals(2, store.unreadableIds().size)
        // The code was spent.
        assertNull(store.currentOffer())
    }

    @Test
    fun `phone restores the vault from the extension`(@TempDir tmp: File) {
        assumeTrue(System.getenv("PASSHOLDER_INTEROP_TEST") == "1", "set PASSHOLDER_INTEROP_TEST=1")
        val store = PhoneVaultStore(File(tmp, "phone"), PlainSecretWrapper)
        store.startRestore()
        val baseUrl = serve(store)
        val offer = store.offerPairing()
        assertEquals(PairingMode.RESTORE, offer.mode)

        val out = runClient(baseUrl, offer.code, restore = true, count = 50, prefix = "wpis", tmp = tmp)

        assertEquals("restore", out.str("mode"))
        // The phone kept the extension's KDF and wrapped vault key and answers with them.
        val info = out.getValue("vaultInfo").jsonObject
        assertEquals(out.getValue("sentKdf"), info.getValue("kdf"))
        assertEquals(out.str("sentWrappedVaultKey"), info.str("wrappedVaultKey"))
        assertEquals(50, out.names().size)

        store.finishRestore(password)
        val entries = store.entries()
        // v3 entries from the extension are stored but not readable by the v2 phone vault yet.
        assertEquals(0, entries.size)
        assertEquals(50, store.unreadableIds().size)
        assertEquals(out.str("deviceId"), store.devices().single().deviceId)
    }
}
