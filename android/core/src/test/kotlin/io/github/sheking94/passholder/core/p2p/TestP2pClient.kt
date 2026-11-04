package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Noise-over-HTTP client for tests: like noiseTransport in transport.ts, but it calls the host directly. */
class TestP2pClient(
    private val deviceId: String,
    private val staticKey: KeyPair,
    private val phonePublicKey: ByteArray,
    private val host: P2pHost,
) {
    private fun field(reply: HostReply, name: String): JsonPrimitive {
        check(reply.status == 200) { "P2P host returned ${reply.status}: ${reply.body}" }
        return (P2pJson.json.parseToJsonElement(reply.body) as JsonObject)[name] as JsonPrimitive
    }

    /** One handshake; returns the session id and the transport ciphers. */
    fun handshake(): Pair<String, TransportCiphers> {
        val noise = NoiseKK.initiator(staticKey, phonePublicKey, P2P_PROLOGUE)
        val first = Encoding.toBase64(noise.writeMessage(ByteArray(0)))
        val body = buildJsonObject {
            put("deviceId", deviceId)
            put("message", first)
        }
        val reply = host.handle("/p2p/v1/handshake", body.toString().toByteArray())
        noise.readMessage(Encoding.fromBase64(field(reply, "message").content))
        return field(reply, "session").content to noise.split()
    }

    /** Handshake plus one sync of the raw JSON [request]; a 200 reply carries the decrypted response JSON. */
    fun sync(request: String): HostReply {
        val (session, ciphers) = handshake()
        val frames = Frames.encrypt(ciphers.send, request)
        val body = buildJsonObject {
            put("session", session)
            put("frames", JsonArray(frames.map { JsonPrimitive(it) }))
        }
        val reply = host.handle("/p2p/v1/sync", body.toString().toByteArray())
        if (reply.status != 200) return reply
        val incoming = (P2pJson.json.parseToJsonElement(reply.body) as JsonObject)["frames"] as JsonArray
        val plain = Frames.decrypt(ciphers.recv, incoming.map { (it as JsonPrimitive).content })
        return HostReply(200, plain.toString())
    }

    /** Typed sync; throws when the host does not answer 200. */
    fun syncResponse(request: P2pSyncRequest): P2pSyncResponse {
        val reply = sync(P2pJson.json.encodeToString(P2pSyncRequest.serializer(), request))
        check(reply.status == 200) { "P2P host returned ${reply.status}: ${reply.body}" }
        return P2pJson.json.decodeFromString(P2pSyncResponse.serializer(), reply.body)
    }
}
