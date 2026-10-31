package io.github.sheking94.passholder.core

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * End to end: the real Node.js server from server/ over HTTPS with a certificate from deploy/make-certs.sh,
 * the Kotlin client, and the Chrome extension's TypeScript code, all on one vault.
 * Opt-in because it needs Node.js, npm install and openssl: PASSHOLDER_SERVER_TEST=1 ./gradlew :core:test
 */
class RealServerTest {
    private val root = File(System.getProperty("passholder.repoRoot"))
    private var server: Process? = null

    @AfterEach
    fun stop() {
        server?.destroy()
        server?.waitFor(5, TimeUnit.SECONDS)
    }

    private fun run(vararg command: String, env: Map<String, String> = emptyMap()): String {
        val process = ProcessBuilder(*command).directory(root).redirectErrorStream(true)
            .apply { environment().putAll(env) }.start()
        val output = process.inputStream.bufferedReader().readText()
        check(process.waitFor() == 0) { "${command.joinToString(" ")} failed:\n$output" }
        return output
    }

    @Test
    fun `phone and browser share a vault through the real server`(@TempDir tmp: File) {
        assumeTrue(System.getenv("PASSHOLDER_SERVER_TEST") == "1", "set PASSHOLDER_SERVER_TEST=1")
        val tls = File(tmp, "tls")
        run("bash", "deploy/make-certs.sh", tls.path, "localhost", "127.0.0.1")
        val port = ServerSocket(0).use { it.localPort }
        server = ProcessBuilder("node", "--disable-warning=ExperimentalWarning", "server/src/main.ts")
            .directory(root).redirectErrorStream(true)
            .apply {
                environment() += mapOf(
                    "PASSHOLDER_TLS_CERT" to "$tls/server.crt",
                    "PASSHOLDER_TLS_KEY" to "$tls/server.key",
                    "PASSHOLDER_PORT" to "$port",
                    "PASSHOLDER_HOST" to "127.0.0.1",
                    "PASSHOLDER_DB" to "$tmp/passholder.db",
                )
            }.start()
        val log = server!!.inputStream.bufferedReader()
        val setupToken = generateSequence { log.readLine() }
            .firstNotNullOf { Regex("setup token: ([0-9a-f]+)").find(it)?.groupValues?.get(1) }
        Thread { log.forEachLine { } }.apply { isDaemon = true }.start()

        // Pairing: the fingerprint the app shows must equal what openssl prints on the Pi.
        val url = "https://127.0.0.1:$port"
        val pin = CertificatePin.fingerprint(CertificatePin.fetchServerCertificate(url))
        val openssl = run("openssl", "x509", "-in", "$tls/server.crt", "-noout", "-fingerprint", "-sha256")
        assertEquals(pin, CertificatePin.normalize(openssl.trim()))

        val password = "Zażółć gęślą jaźń 2026"
        val phone = VaultStore(MemoryStore())
        phone.createVault(url, pin, setupToken, password)
        phone.upsert(UUID.randomUUID().toString(), Credentials("z-telefonu.pl", "jan", "z Kotlina"))
        phone.sync()

        val seenByBrowser = run(
            "node", "--disable-warning=ExperimentalWarning", "--experimental-transform-types", "android/core/src/test/resources/interop.ts",
            // Base64, because the JVM may pass non-ASCII arguments in the platform charset.
            root.path, "https://localhost:$port", Encoding.toBase64(password.toByteArray()),
            env = mapOf("NODE_EXTRA_CA_CERTS" to "$tls/ca.crt"),
        ).trim().lines().last()
        assertEquals("""["z-telefonu.pl"]""", seenByBrowser)

        phone.sync()
        assertEquals(listOf("z-przegladarki.pl", "z-telefonu.pl"), phone.entries().map { it.credentials!!.name })
        assertEquals("z TS", phone.entries().first().credentials!!.password)
    }
}
