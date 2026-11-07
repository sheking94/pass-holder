package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Outcome of [TestP2pClient.pair]: every reply the phone gave, plus what the extension learned on success. */
data class PairResult(
    val hello: HostReply,
    val start: HostReply?,
    val finish: HostReply?,
    val sid: String?,
    val key: ByteArray?,
    val phoneIdentity: DeviceIdentity?,
    val phoneVaultInfo: VaultInfo?,
)

/** How a test client reaches the phone: a direct call, or a real HTTP request ([HttpTestTransport]). */
typealias TestTransport = (path: String, body: ByteArray) -> HostReply

/** POSTs to a [SyncHttpServer] on 127.0.0.1:[port] with HttpURLConnection. */
class HttpTestTransport(private val port: Int) : TestTransport {
    override fun invoke(path: String, body: ByteArray): HostReply {
        val conn = java.net.URI("http://127.0.0.1:$port$path").toURL().openConnection() as java.net.HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 10_000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            val status = conn.responseCode
            val stream = if (status < 400) conn.inputStream else conn.errorStream
            val text = stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
            return HostReply(status, text)
        } finally {
            conn.disconnect()
        }
    }
}

/** Noise-over-HTTP client for tests: like noiseTransport in transport.ts, over [transport]. */
class TestP2pClient(
    private val deviceId: String,
    private val staticKey: KeyPair,
    private val phonePublicKey: ByteArray,
    private val transport: TestTransport,
) {
    /** Calls [host] directly. */
    constructor(deviceId: String, staticKey: KeyPair, phonePublicKey: ByteArray, host: P2pHost) :
        this(deviceId, staticKey, phonePublicKey, host::handle)

    private fun field(reply: HostReply, name: String): JsonPrimitive {
        check(reply.status == 200) { "P2P host returned ${reply.status}: ${reply.body}" }
        return (P2pJson.json.parseToJsonElement(reply.body) as JsonObject)[name] as JsonPrimitive
    }

    private fun sendHandshake(noise: NoiseKK): HostReply {
        val first = Encoding.toBase64(noise.writeMessage(ByteArray(0)))
        val body = buildJsonObject {
            put("deviceId", deviceId)
            put("message", first)
        }
        return transport("/p2p/v1/handshake", body.toString().toByteArray())
    }

    /** The raw reply to a handshake, for tests that expect a refusal. */
    fun handshakeReply(): HostReply = sendHandshake(NoiseKK.initiator(staticKey, phonePublicKey, P2P_PROLOGUE))

    /** One handshake; returns the session id and the transport ciphers. */
    fun handshake(): Pair<String, TransportCiphers> {
        val noise = NoiseKK.initiator(staticKey, phonePublicKey, P2P_PROLOGUE)
        val reply = sendHandshake(noise)
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
        val reply = transport("/p2p/v1/sync", body.toString().toByteArray())
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

    companion object {
        private fun obj(reply: HostReply): JsonObject = P2pJson.json.parseToJsonElement(reply.body) as JsonObject

        private fun text(reply: HostReply, name: String): String = (obj(reply)[name] as JsonPrimitive).content

        /**
         * Plays the extension (CPace initiator, ad = UTF-8 of its deviceId) against [pairing] with [code].
         * [vaultInfo] is sent in /pair/finish when not null, whatever the offered mode, so tests can break the rules.
         * [sid] overrides the sid learned from /pair/hello. Stops at the first reply that is not 200.
         */
        fun pair(
            pairing: PairingHost,
            code: String,
            identity: DeviceIdentity,
            vaultInfo: VaultInfo? = null,
            sid: String? = null,
        ): PairResult = pair(
            { path, body -> pairing.handle(path, P2pJson.json.parseToJsonElement(Encoding.fromUtf8(body)) as JsonObject)!! },
            code, identity, vaultInfo, sid,
        )

        /** Same as above over any [transport], e.g. real HTTP to a [PhoneRouter]. */
        fun pair(
            transport: TestTransport,
            code: String,
            identity: DeviceIdentity,
            vaultInfo: VaultInfo? = null,
            sid: String? = null,
        ): PairResult {
            fun post(path: String, body: JsonObject) = transport(path, body.toString().toByteArray())
            val hello = post("/p2p/v1/pair/hello", JsonObject(emptyMap()))
            if (hello.status != 200) return PairResult(hello, null, null, null, null, null, null)
            val usedSid = sid ?: text(hello, "sid")
            val cpace = Cpace.start(Encoding.utf8(code), Cpace.PAIRING_CI, Encoding.fromBase64(usedSid), Encoding.utf8(identity.deviceId))
            val start = post(
                "/p2p/v1/pair/start",
                buildJsonObject {
                    put("sid", usedSid)
                    put("message", Encoding.toBase64(cpace.message))
                },
            )
            if (start.status != 200) return PairResult(hello, start, null, usedSid, null, null, null)
            val isk = Cpace.finish(cpace.state, Encoding.fromBase64(text(start, "message")), CpaceRole.INITIATOR)
            val key = Pairing.key(isk)
            val finish = post(
                "/p2p/v1/pair/finish",
                buildJsonObject {
                    put("sid", usedSid)
                    put("identity", Pairing.sealIdentity(key, CpaceRole.INITIATOR, identity))
                    if (vaultInfo != null) put("vaultInfo", Pairing.sealVaultInfo(key, CpaceRole.INITIATOR, vaultInfo))
                },
            )
            if (finish.status != 200) return PairResult(hello, start, finish, usedSid, key, null, null)
            return PairResult(
                hello, start, finish, usedSid, key,
                Pairing.openIdentity(key, CpaceRole.RESPONDER, text(finish, "identity")),
                Pairing.openVaultInfo(key, CpaceRole.RESPONDER, text(finish, "vaultInfo")),
            )
        }
    }
}
