package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.files.FileChunk
import io.github.sheking94.passholder.core.files.FileChunks
import io.github.sheking94.passholder.core.files.MemoryFileStore
import io.github.sheking94.passholder.core.login
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The extension's real TypeScript sync client (Noise over HTTP) against the Kotlin host.
 * Opt-in because it needs Node.js: PASSHOLDER_INTEROP_TEST=1 ./gradlew :core:test
 */
class P2pInteropTest {
    private val root = File(System.getProperty("passholder.repoRoot"))
    private val web = MockWebServer()
    private val syncCalls = AtomicInteger()
    private val password = "zażółć 😀"

    @AfterEach
    fun stop() = web.shutdown()

    private class Fixture(
        val store: MemorySyncStore,
        val vault: PhoneVault,
        val vaultKey: ByteArray,
        val epoch: String,
        val deviceKey: KeyPair,
        val hostKey: KeyPair,
        val deviceId: String,
    )

    private fun start(addresses: List<String>, files: MemoryFileStore? = null): Fixture {
        val store = MemorySyncStore()
        val vaultKey = Encoding.randomBytes(32)
        val epoch = Encoding.toBase64(Encoding.randomBytes(16))
        val hostKey = NoiseKeys.generate()
        val deviceKey = NoiseKeys.generate()
        val deviceId = "extension-1"
        val host = P2pHost(
            staticKey = hostKey,
            devices = { listOf(PairedDevice(deviceId, "Extension", deviceKey.publicKey)) },
            store = store,
            epoch = epoch,
            addresses = { addresses },
            files = files,
        )
        web.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                if (path == "/p2p/v2/sync") syncCalls.incrementAndGet()
                val reply = host.handle(path, request.body.readByteArray())
                return MockResponse().setResponseCode(reply.status)
                    .setHeader("Content-Type", "application/json").setBody(reply.body)
            }
        }
        web.start()
        return Fixture(store, PhoneVault(store, vaultKey, "phone"), vaultKey, epoch, deviceKey, hostKey, deviceId)
    }

    /** Runs the TypeScript client and returns the JSON it prints on its last line. */
    private fun runClient(f: Fixture, count: Int, startPrefix: String, tmp: File, phoneFileId: String? = null): JsonObject {
        val config = File(tmp, "config.json")
        config.writeText(
            buildJsonObject {
                put("deviceId", f.deviceId)
                put("privateKey", Encoding.toHex(f.deviceKey.privateKey))
                put("phonePublicKey", Encoding.toHex(f.hostKey.publicKey))
                put("vaultKey", Encoding.toHex(f.vaultKey))
                put("epoch", f.epoch)
                put("count", count)
                put("startPrefix", startPrefix)
                put("password", password)
                if (phoneFileId != null) {
                    put("files", true)
                    put("phoneFileId", phoneFileId)
                }
            }.toString(),
            Charsets.UTF_8,
        )
        // No --experimental-transform-types: Node 26 dropped it, and the script and core/src/p2p need only type stripping.
        val process = ProcessBuilder(
            "node",
            "--disable-warning=ExperimentalWarning",
            "android/core/src/test/resources/p2p-interop.ts",
            root.path,
            web.url("/").toString().trimEnd('/'),
            config.path,
        ).directory(root).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader(Charsets.UTF_8).readText()
        check(process.waitFor(5, TimeUnit.MINUTES) && process.exitValue() == 0) { "node client failed:\n$output" }
        return Json.parseToJsonElement(output.trim().lines().last()).jsonObject
    }

    private fun JsonObject.names() = getValue("names").jsonArray.map { it.jsonPrimitive.content }

    @Test
    fun `extension client and phone exchange entries`(@TempDir tmp: File) {
        assumeTrue(System.getenv("PASSHOLDER_INTEROP_TEST") == "1", "set PASSHOLDER_INTEROP_TEST=1")
        val addresses = listOf("192.168.1.5:8787")
        val f = start(addresses)
        f.vault.upsertContent("phone-1", login("z-telefonu.pl", "jan", "z Kotlina"))

        val out = runClient(f, 1, "z-przegladarki", tmp)

        assertEquals(listOf("z-przegladarki-0", "z-telefonu.pl"), out.names())
        assertEquals(f.epoch, out.getValue("epoch").jsonPrimitive.content)
        assertEquals(addresses, out.getValue("addresses").jsonArray.map { it.jsonPrimitive.content })
        val fromBrowser = f.vault.entries().single { it.credentials.name == "z-przegladarki-0" }
        assertEquals(password, fromBrowser.credentials.password)
        assertEquals(f.deviceId, fromBrowser.hlc.d)
    }

    @Test
    fun `large vaults sync in pages both ways`(@TempDir tmp: File) {
        assumeTrue(System.getenv("PASSHOLDER_INTEROP_TEST") == "1", "set PASSHOLDER_INTEROP_TEST=1")
        val f = start(emptyList())
        for (i in 0 until 1300) f.vault.upsertContent("phone-$i", login("z-telefonu-$i", "u", "p".repeat(100)))

        val out = runClient(f, 1200, "z-przegladarki", tmp)

        val names = out.names()
        assertEquals(2500, names.size)
        assertEquals(names.sorted(), names)
        assertEquals(2500, f.vault.entries().size)
        assertTrue(syncCalls.get() >= 3, "sync calls: ${syncCalls.get()}")
    }

    @Test
    fun `extension file sync uploads to and downloads from the phone`(@TempDir tmp: File) {
        assumeTrue(System.getenv("PASSHOLDER_INTEROP_TEST") == "1", "set PASSHOLDER_INTEROP_TEST=1")
        val files = MemoryFileStore()
        val f = start(emptyList(), files)
        // A file added on the phone: complete in its store, described by an entry.
        val original = ByteArray(300_000) { (it * 13 + 5).toByte() }
        val enc = FileChunks.encrypt(original, "z-telefonu.bin", "application/octet-stream")
        enc.blobs.forEachIndexed { i, blob -> files.put(FileChunk(enc.attachment.id, i, enc.blobs.size, blob), 0L) }
        f.vault.upsertContent(
            "phone-1",
            EntryContent("z-telefonu.pl", "", LoginFields("jan", "x"), emptyList(), listOf(enc.attachment)),
        )

        val out = runClient(f, 0, "z-przegladarki", tmp, phoneFileId = enc.attachment.id)

        val result = out.getValue("files").jsonObject
        assertEquals(1, result.getValue("uploaded").jsonPrimitive.content.toInt())
        assertEquals(1, result.getValue("downloaded").jsonPrimitive.content.toInt())
        assertEquals(0, result.getValue("pending").jsonPrimitive.content.toInt())
        assertEquals(Encoding.sha256Hex(original), result.getValue("downloadedSha256").jsonPrimitive.content)
        // The plugin's file reached the phone's store and decrypts to the original bytes.
        val fromPlugin: Attachment = f.vault.entries().single { it.data.content.name == "z-plikiem" }
            .data.content.attachments.single()
        assertEquals(3, fromPlugin.chunks)
        val blobs = (0 until fromPlugin.chunks).map { files.get(fromPlugin.id, it)!! }
        val bytes = FileChunks.decrypt(fromPlugin, blobs)
        assertEquals(600_000, bytes.size)
        assertEquals(fromPlugin.sha256, Encoding.sha256Hex(bytes))
    }
}
