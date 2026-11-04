package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest

class PairedDevice(val deviceId: String, val name: String, val staticPublicKey: ByteArray)

/** Status code and JSON body of a host answer; the HTTP layer only copies them out. */
data class HostReply(val status: Int, val body: String)

private class Session(
    val deviceId: String,
    val staticPublicKey: ByteArray,
    val send: CipherState,
    val recv: CipherState,
    val expiresAt: Long,
)

/**
 * Phone side of P2P sync (port of host.ts): Noise KK handshake, then exactly one encrypted sync request per session.
 * handle() may be called from many threads; each session's ciphers serve one request only.
 */
class P2pHost(
    private val staticKey: KeyPair,
    private val devices: () -> List<PairedDevice>,
    private val store: SyncStore,
    private val epoch: String,
    private val addresses: () -> List<String>,
    private val now: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val MAX_BODY_BYTES = 1024 * 1024
        const val SESSION_TTL_MS = 60_000L

        /** Most sessions alive at once; a handshake beyond that gets 503 until some expire or are used. */
        const val MAX_SESSIONS = 32
    }

    private val sessions = HashMap<String, Session>()

    private fun fail(status: Int, error: String) =
        HostReply(status, buildJsonObject { put("error", error) }.toString())

    fun handle(path: String, body: ByteArray): HostReply {
        if (body.size > MAX_BODY_BYTES) return fail(413, "body too large")
        synchronized(sessions) { prune() }
        return when (path) {
            "/p2p/v1/handshake" -> handshake(body)
            "/p2p/v1/sync" -> sync(body)
            else -> fail(404, "not found")
        }
    }

    /** Caller holds the sessions lock. */
    private fun prune() {
        val t = now()
        sessions.values.removeAll { it.expiresAt <= t }
    }

    /** The body as a JSON object; null for invalid UTF-8, invalid JSON or any other JSON value. */
    private fun parseObject(body: ByteArray): JsonObject? = try {
        P2pJson.json.parseToJsonElement(Encoding.fromUtf8(body)) as? JsonObject
    } catch (_: Exception) {
        null
    }

    private fun JsonElement?.text(): String? = if (this is JsonPrimitive && isString) content else null

    private fun handshake(body: ByteArray): HostReply {
        val obj = parseObject(body) ?: return fail(400, "malformed request")
        val deviceId = obj["deviceId"].text()
        val messageText = obj["message"].text()
        if (deviceId == null || messageText == null) return fail(400, "malformed request")
        val device = devices().firstOrNull { it.deviceId == deviceId } ?: return fail(403, "device not paired")
        // handle() already pruned the expired sessions.
        if (synchronized(sessions) { sessions.size } >= MAX_SESSIONS) return fail(503, "too many sessions")
        val message = try {
            Encoding.fromBase64(messageText)
        } catch (_: IllegalArgumentException) {
            return fail(400, "malformed request")
        }
        val noise = NoiseKK.responder(staticKey, device.staticPublicKey, P2P_PROLOGUE)
        val reply: ByteArray
        val ciphers: TransportCiphers
        try {
            noise.readMessage(message)
            reply = noise.writeMessage(ByteArray(0))
            ciphers = noise.split()
        } catch (_: IllegalArgumentException) {
            return fail(400, "handshake failed")
        } catch (_: IllegalStateException) {
            return fail(400, "handshake failed")
        }
        val id = Encoding.toBase64(Encoding.randomBytes(16))
        val session = Session(
            device.deviceId, device.staticPublicKey.copyOf(), ciphers.send, ciphers.recv, now() + SESSION_TTL_MS,
        )
        synchronized(sessions) {
            // Concurrent handshakes may have filled the map since the check above.
            if (sessions.size >= MAX_SESSIONS) return fail(503, "too many sessions")
            sessions[id] = session
        }
        return HostReply(
            200,
            buildJsonObject {
                put("session", id)
                put("message", Encoding.toBase64(reply))
            }.toString(),
        )
    }

    private fun sync(body: ByteArray): HostReply {
        val obj = parseObject(body) ?: return fail(400, "malformed request")
        val sessionId = obj["session"].text()
        val frameArray = obj["frames"] as? JsonArray
        if (sessionId == null || frameArray == null ||
            frameArray.size < 1 || frameArray.size > Frames.MAX_FRAMES
        ) {
            return fail(400, "malformed request")
        }
        val frames = frameArray.map { it.text() ?: return fail(400, "malformed request") }
        // One attempt per session, whatever the outcome.
        val session = synchronized(sessions) { sessions.remove(sessionId) }
        if (session == null || session.expiresAt <= now()) return fail(401, "unknown or expired session")
        // The device may have been removed (or re-paired with another key) after the handshake.
        val stillPaired = devices().any {
            it.deviceId == session.deviceId && MessageDigest.isEqual(it.staticPublicKey, session.staticPublicKey)
        }
        if (!stillPaired) return fail(403, "device not paired")
        val request = try {
            Frames.decrypt(session.recv, frames)
        } catch (_: IllegalArgumentException) {
            return fail(400, "cannot decrypt request")
        }
        synchronized(store) { HostSync.validate(store, epoch, request) }?.let { return fail(400, it) }
        return try {
            val response = HostSync.process(store, epoch, addresses(), request)
            val encrypted = Frames.encrypt(session.send, P2pJson.json.encodeToString(P2pSyncResponse.serializer(), response))
            HostReply(200, buildJsonObject { put("frames", JsonArray(encrypted.map { JsonPrimitive(it) })) }.toString())
        } catch (_: Exception) {
            fail(500, "internal error")
        }
    }
}
