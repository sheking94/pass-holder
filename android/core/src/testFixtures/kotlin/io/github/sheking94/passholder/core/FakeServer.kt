package io.github.sheking94.passholder.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.security.MessageDigest

/** Server-side sync from docs/SPEC.md §5, ported from core/src/protocol.ts for tests. */
class MemorySyncServer {
    val records = linkedMapOf<String, RemoteRecord>()
    var revision = 0L

    @Synchronized
    fun process(request: SyncRequest): SyncResponse {
        val accepted = mutableListOf<Accepted>()
        val conflicts = mutableListOf<RemoteRecord>()
        val handled = mutableSetOf<String>()
        for (change in request.changes) {
            require(handled.add(change.id)) { "Duplicate change for ${change.id}" }
            val existing = records[change.id]
            if ((existing?.revision ?: 0) != change.baseRevision) {
                conflicts += existing ?: throw IllegalArgumentException("Unknown base revision for ${change.id}")
                continue
            }
            revision++
            records[change.id] = RemoteRecord(change.id, revision, change.deleted, change.blob)
            accepted += Accepted(change.id, revision)
        }
        val changes = records.values.filter { it.revision > request.sinceRevision && it.id !in handled }.sortedBy { it.revision }
        return SyncResponse(revision, accepted, conflicts, changes)
    }
}

/** Just enough of the server's HTTP API (server/src/app.ts) to test the client without Node.js. */
class FakeServer(val setupToken: String = "token") : Dispatcher() {
    val sync = MemorySyncServer()
    private val json = Json { ignoreUnknownKeys = true }
    private var meta: Triple<KdfParams, String, String>? = null // kdf, authHash hex, wrappedVaultKey
    private val tokens = mutableSetOf<String>()
    var sessionCount = 0

    /** What a restart of the real server does: sessions live only in its memory. */
    @Synchronized
    fun forgetSessions() = tokens.clear()

    private fun reply(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)
    private fun error(code: Int, message: String) = reply(code, """{"error":"$message"}""")
    private fun hash(authKeyB64: String) = Encoding.toHex(MessageDigest.getInstance("SHA-256").digest(Encoding.fromBase64(authKeyB64)))

    @Synchronized
    override fun dispatch(request: RecordedRequest): MockResponse {
        val body = request.body.readUtf8()
        return when ("${request.method} ${request.path}") {
            "GET /api/v1/status" -> reply(200, """{"initialized":${meta != null},"version":"1"}""")
            "POST /api/v1/setup" -> {
                val setup = json.decodeFromString<SetupRequest>(body)
                when {
                    meta != null -> error(409, "Vault already exists")
                    setup.setupToken != setupToken -> error(403, "Invalid setup token")
                    else -> {
                        meta = Triple(setup.kdf, hash(setup.authKey), setup.wrappedVaultKey)
                        reply(201, "{}")
                    }
                }
            }
            "GET /api/v1/prelogin" -> meta?.let { reply(200, """{"kdf":${json.encodeToString(it.first)}}""") } ?: error(404, "Vault not set up")
            "POST /api/v1/session" -> {
                val m = meta ?: return error(404, "Vault not set up")
                val authKey = json.parseToJsonElement(body).jsonObject["authKey"]!!.jsonPrimitive.content
                if (hash(authKey) != m.second) return error(401, "Wrong master password")
                sessionCount++
                val token = Encoding.toHex(Encoding.randomBytes(16)).also { tokens += it }
                reply(200, json.encodeToString(SessionResponse(token, System.currentTimeMillis() + 15 * 60_000, m.third)))
            }
            "POST /api/v1/sync" -> {
                if (request.getHeader("Authorization")?.removePrefix("Bearer ") !in tokens) return error(401, "Log in first")
                reply(200, json.encodeToString(sync.process(json.decodeFromString(body))))
            }
            else -> error(404, "Not found")
        }
    }

    companion object {
        fun start(dispatcher: FakeServer = FakeServer()): Pair<MockWebServer, FakeServer> =
            MockWebServer().apply { this.dispatcher = dispatcher; start() } to dispatcher
    }
}
