package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object PhoneSync {
    /** TCP port of the phone host; the phone's addresses are `http://<IPv4>:8787`. */
    const val PORT = 8787

    /** Sync mode turns itself off after this long without a successful sync, file request or pairing. */
    const val SYNC_IDLE_MS = 300_000L
}

/**
 * Every request the phone's HTTP server gets: ping, pairing ([pairing]) and Noise sync and files ([host]; the old v1 paths are forwarded too, the host answers them 410).
 * Checks in order: unknown path 404, body not a JSON object 400, then the path's own handler; [onActivity] after a
 * 200 answer to an authenticated request (sync, file, pairing finish).
 * [host] is null until the phone has a vault (or a restore in progress): handshake, sync and file then answer 503.
 */
class PhoneRouter(
    private val pairing: PairingHost,
    private val host: () -> P2pHost?,
    /**
     * Called after each 200 answer on [ACTIVITY_PATHS]; sync mode counts idle time from it. Ping, handshakes and
     * pairing steps before the code check do not count: anyone on the network can send those.
     */
    private val onActivity: () -> Unit,
    /** Gets the cause of every 500 answer; e.g. to log it. */
    private val onError: (Throwable) -> Unit = {},
) {
    private companion object {
        const val PING = "/p2p/v1/ping"
        val SYNC_PATHS = setOf("/p2p/v1/handshake", "/p2p/v1/sync", "/p2p/v2/handshake", "/p2p/v2/sync", "/p2p/v2/file")
        val PAIRING_PATHS = setOf("/p2p/v1/pair/hello", "/p2p/v1/pair/start", "/p2p/v1/pair/finish")

        /** Paths whose 200 answer proves a paired device (Noise session) or the pairing code (CPace). */
        val ACTIVITY_PATHS = setOf("/p2p/v2/sync", "/p2p/v2/file", "/p2p/v1/pair/finish")
    }

    private fun fail(status: Int, error: String) =
        HostReply(status, buildJsonObject { put("error", error) }.toString())

    fun handle(path: String, body: ByteArray): HostReply {
        if (path != PING && path !in SYNC_PATHS && path !in PAIRING_PATHS) return fail(404, "not found")
        val obj = try {
            P2pJson.json.parseToJsonElement(Encoding.fromUtf8(body)) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return fail(400, "malformed request")
        val reply = try {
            when (path) {
                PING -> HostReply(200, buildJsonObject { put("ok", true) }.toString())
                in SYNC_PATHS -> host()?.handle(path, body) ?: fail(503, "vault not ready")
                else -> pairing.handle(path, obj) ?: fail(404, "not found")
            }
        } catch (e: Exception) {
            reportError(onError, e)
            fail(500, "internal error")
        }
        // Only proven devices keep sync mode awake: a pinging neighbour or web page cannot.
        if (reply.status == 200 && path in ACTIVITY_PATHS) onActivity()
        return reply
    }
}
