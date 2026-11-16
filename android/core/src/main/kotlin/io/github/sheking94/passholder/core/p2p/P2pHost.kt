package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.files.FileHost
import io.github.sheking94.passholder.core.files.FileStore
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
 * Phone side of P2P sync (port of host.ts): Noise KK handshake, then exactly one encrypted request per session,
 * either a sync (`/p2p/v2/sync`) or a file request (`/p2p/v2/file`, only with [files]).
 * handle() may be called from many threads; each session's ciphers serve one request only.
 */
class P2pHost(
    private val staticKey: KeyPair,
    private val devices: () -> List<PairedDevice>,
    private val store: SyncStore,
    private val epoch: String,
    private val addresses: () -> List<String>,
    private val now: () -> Long = System::currentTimeMillis,
    /** Called with the device id after each sync answered 200; a failure here does not change the answer. */
    private val onSynced: (deviceId: String) -> Unit = {},
    /** Gets the cause of every 500 answer and of a failed [onSynced]; e.g. to log it. */
    private val onError: (Throwable) -> Unit = {},
    /** Encrypted file chunks; without it `/p2p/v2/file` answers 404 like an unknown path. */
    private val files: FileStore? = null,
) {
    companion object {
        const val MAX_BODY_BYTES = 1024 * 1024
        const val SESSION_TTL_MS = 60_000L

        /** Most sessions alive at once; a handshake beyond that gets 503 until some expire or are used. */
        const val MAX_SESSIONS = 32

        /** Most sessions of one device alive at once, so one device's messages cannot fill the whole table. */
        const val MAX_SESSIONS_PER_DEVICE = 4

        /**
         * How many accepted first handshake messages the host remembers (oldest dropped first). A copy of one of them
         * is refused with 400: the message holds nothing fresh from the phone, so without this memory every copy would
         * open a session. Only messages that passed Noise (made by a paired device) are kept.
         */
        const val MAX_SEEN_HANDSHAKES = 4096
    }

    private val sessions = HashMap<String, Session>()

    /** Ephemeral keys (first 32 bytes, Base64) of accepted handshakes, oldest first. Guarded by the sessions lock. */
    private val seen = LinkedHashSet<String>()

    private fun fail(status: Int, error: String) = HostReply(status, buildJsonObject { put("error", error) }.toString())

    fun handle(path: String, body: ByteArray): HostReply {
        if (body.size > MAX_BODY_BYTES) return fail(413, "body too large")
        synchronized(sessions) { prune() }
        return when (path) {
            "/p2p/v2/handshake" -> handshake(body)

            "/p2p/v2/sync" -> sync(body)

            "/p2p/v2/file" -> if (files != null) file(files, body) else fail(404, "not found")

            // The v1 sync protocol is gone; tell old clients to update instead of pretending the path is unknown.
            "/p2p/v1/handshake", "/p2p/v1/sync" -> fail(410, "update required")

            else -> fail(404, "not found")
        }
    }

    /** 400 for a copy of an accepted message, 503 when the table or the device's share is full. Caller holds the lock. */
    private fun refusal(ephemeral: String, deviceId: String): HostReply? = when {
        ephemeral in seen -> fail(400, "replayed handshake")
        sessions.size >= MAX_SESSIONS -> fail(503, "too many sessions")
        sessions.values.count { it.deviceId == deviceId } >= MAX_SESSIONS_PER_DEVICE -> fail(503, "too many sessions")
        else -> null
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
        val message = try {
            Encoding.fromBase64(messageText)
        } catch (_: IllegalArgumentException) {
            return fail(400, "malformed request")
        }
        val ephemeral = Encoding.toBase64(message.copyOf(minOf(message.size, 32)))
        // handle() already pruned the expired sessions.
        synchronized(sessions) { refusal(ephemeral, device.deviceId) }?.let { return it }
        val reply: ByteArray
        val ciphers: TransportCiphers
        try {
            val noise = NoiseKK.responder(staticKey, device.staticPublicKey, P2P_PROLOGUE)
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
            device.deviceId,
            device.staticPublicKey.copyOf(),
            ciphers.send,
            ciphers.recv,
            now() + SESSION_TTL_MS,
        )
        synchronized(sessions) {
            // Concurrent handshakes may have filled the map or used the same message since the check above.
            refusal(ephemeral, device.deviceId)?.let { return it }
            seen.add(ephemeral)
            if (seen.size > MAX_SEEN_HANDSHAKES) seen.remove(seen.first())
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

    /**
     * The steps shared by sync and file requests: body, one-time session, device still paired, decrypting the frames.
     * Then [process] gets the session and the decrypted request.
     */
    private fun withSession(body: ByteArray, process: (Session, JsonElement) -> HostReply): HostReply {
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
        return process(session, request)
    }

    /** A 200 answer: [json] encrypted in frames with the session's send cipher. */
    private fun encrypted(session: Session, json: String): HostReply {
        val encrypted = Frames.encrypt(session.send, json)
        return HostReply(200, buildJsonObject { put("frames", JsonArray(encrypted.map { JsonPrimitive(it) })) }.toString())
    }

    private fun sync(body: ByteArray): HostReply = withSession(body) { session, request ->
        synchronized(store) { HostSync.validate(store, epoch, request) }?.let { return@withSession fail(400, it) }
        val reply = try {
            val response = HostSync.process(store, epoch, addresses(), request)
            encrypted(session, P2pJson.json.encodeToString(P2pSyncResponse.serializer(), response))
        } catch (e: Exception) {
            reportError(onError, e)
            return@withSession fail(500, "internal error")
        }
        try {
            onSynced(session.deviceId)
        } catch (e: Exception) {
            // Only bookkeeping (last sync time); the changes are already stored.
            reportError(onError, e)
        }
        reply
    }

    /** A 200 file answer goes out encrypted, any other status in plaintext (like host.ts). */
    private fun file(files: FileStore, body: ByteArray): HostReply = withSession(body) { session, request ->
        try {
            val reply = FileHost.process(files, epoch, request, now())
            if (reply.status == 200) encrypted(session, reply.body.toString()) else HostReply(reply.status, reply.body.toString())
        } catch (e: Exception) {
            reportError(onError, e)
            fail(500, "internal error")
        }
    }
}
