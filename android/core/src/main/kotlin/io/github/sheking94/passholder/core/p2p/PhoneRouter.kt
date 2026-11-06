package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object PhoneSync {
    /** TCP port of the phone host; the phone's addresses are `http://<IPv4>:8787`. */
    const val PORT = 8787

    /** Sync mode turns itself off after this long without a request. */
    const val SYNC_IDLE_MS = 300_000L
}

/**
 * Every request the phone's HTTP server gets: ping, pairing ([pairing]) and Noise sync ([host]).
 * Checks in order: unknown path 404, body not a JSON object 400, then the path's own handler.
 * [host] is null until the phone has a vault (or a restore in progress): handshake and sync then answer 503.
 */
class PhoneRouter(
    private val pairing: PairingHost,
    private val host: () -> P2pHost?,
    /** Called on every request, before anything else; sync mode counts idle time from it. */
    private val onRequest: () -> Unit,
) {
    private companion object {
        const val PING = "/p2p/v1/ping"
        const val HANDSHAKE = "/p2p/v1/handshake"
        const val SYNC = "/p2p/v1/sync"
        val PAIRING_PATHS = setOf("/p2p/v1/pair/hello", "/p2p/v1/pair/start", "/p2p/v1/pair/finish")
    }

    private fun fail(status: Int, error: String) =
        HostReply(status, buildJsonObject { put("error", error) }.toString())

    fun handle(path: String, body: ByteArray): HostReply {
        onRequest()
        if (path != PING && path != HANDSHAKE && path != SYNC && path !in PAIRING_PATHS) return fail(404, "not found")
        val obj = try {
            P2pJson.json.parseToJsonElement(Encoding.fromUtf8(body)) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return fail(400, "malformed request")
        return try {
            when (path) {
                PING -> HostReply(200, buildJsonObject { put("ok", true) }.toString())
                HANDSHAKE, SYNC -> host()?.handle(path, body) ?: fail(503, "vault not ready")
                else -> pairing.handle(path, obj) ?: fail(404, "not found")
            }
        } catch (_: Exception) {
            fail(500, "internal error")
        }
    }
}
