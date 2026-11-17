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
        val SYNC_PATHS = setOf(
            P2pPaths.LEGACY_HANDSHAKE,
            P2pPaths.LEGACY_SYNC,
            P2pPaths.HANDSHAKE,
            P2pPaths.SYNC,
            P2pPaths.FILE,
        )
        val PAIRING_PATHS = setOf(P2pPaths.PAIR_HELLO, P2pPaths.PAIR_START, P2pPaths.PAIR_FINISH)

        /** Paths whose 200 answer proves a paired device (Noise session) or the pairing code (CPace). */
        val ACTIVITY_PATHS = setOf(P2pPaths.SYNC, P2pPaths.FILE, P2pPaths.PAIR_FINISH)
    }

    fun handle(path: String, body: ByteArray): HostReply {
        if (path != P2pPaths.PING && path !in SYNC_PATHS && path !in PAIRING_PATHS) return HostReply.error(404, "not found")
        val obj = try {
            P2pJson.json.parseToJsonElement(Encoding.fromUtf8(body)) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return HostReply.error(400, "malformed request")
        val reply = try {
            when (path) {
                P2pPaths.PING -> HostReply(200, buildJsonObject { put("ok", true) }.toString())
                in SYNC_PATHS -> host()?.handle(path, obj) ?: HostReply.error(503, "vault not ready")
                else -> pairing.handle(path, obj) ?: HostReply.error(404, "not found")
            }
        } catch (e: Exception) {
            reportError(onError, e)
            HostReply.error(500, "internal error")
        }
        // Only proven devices keep sync mode awake: a pinging neighbour or web page cannot.
        if (reply.status == 200 && path in ACTIVITY_PATHS) onActivity()
        return reply
    }
}
