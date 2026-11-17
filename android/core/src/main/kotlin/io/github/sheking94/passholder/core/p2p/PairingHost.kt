package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.GeneralSecurityException

/** How long a pairing code shown on the phone stays valid. */
const val PAIRING_CODE_TTL_MS = 120_000L

/** How long the pairing key from /pair/start waits for /pair/finish. */
const val PAIRING_FINISH_TTL_MS = 30_000L

enum class PairingMode(val wire: String) { PAIR("pair"), RESTORE("restore") }

/** [code] is the 8-digit code shown to the user, [sid] Base64 of 16 random bytes. */
data class PairingOffer(val code: String, val sid: String, val mode: PairingMode, val expiresAt: Long)

private class PendingFinish(val sid: String, val mode: PairingMode, val key: ByteArray, val expiresAt: Long)

/**
 * Phone side of pairing over HTTP (/p2p/v1/pair/hello, start, finish). The phone is the CPace responder.
 * At most one offer exists; the first /pair/start with its sid spends it whatever the outcome,
 * and the resulting key serves exactly one /pair/finish within [PAIRING_FINISH_TTL_MS].
 */
class PairingHost(
    private val identity: () -> DeviceIdentity,
    /** In restore mode gets the extension's opened vault info, after [onPaired] saved it. */
    private val vaultInfo: (restored: VaultInfo?) -> VaultInfo,
    private val onPaired: (device: StoredDevice, restored: VaultInfo?) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
    /** Gets the cause of every 500 answer (the extension only sees "internal error"); e.g. to log it. */
    private val onError: (Throwable) -> Unit = {},
) {
    private var offer: PairingOffer? = null
    private var consumed = false
    private var pending: PendingFinish? = null

    /** A new offer replaces the old one and any pairing waiting for /pair/finish. */
    @Synchronized
    fun offer(mode: PairingMode): PairingOffer {
        pending = null
        consumed = false
        return PairingOffer(
            code = Pairing.generateCode(),
            sid = Encoding.toBase64(Encoding.randomBytes(16)),
            mode = mode,
            expiresAt = now() + PAIRING_CODE_TTL_MS,
        ).also { offer = it }
    }

    @Synchronized
    fun cancel() {
        offer = null
        consumed = false
        pending = null
    }

    /** The offer whose code can still be used: not expired and not spent by /pair/start. */
    @Synchronized
    fun current(): PairingOffer? = usableOffer()

    /** Null when [path] is not a pairing path. [body] is already known to be a JSON object. */
    @Synchronized
    fun handle(path: String, body: JsonObject): HostReply? = when (path) {
        "/p2p/v1/pair/hello" -> hello()
        "/p2p/v1/pair/start" -> start(body)
        "/p2p/v1/pair/finish" -> finish(body)
        else -> null
    }

    private fun fail(status: Int, error: String) = HostReply(status, buildJsonObject { put("error", error) }.toString())

    private fun malformed() = fail(400, "malformed request")

    private fun noPairing() = fail(404, "no pairing")

    private fun usableOffer(): PairingOffer? {
        val o = offer ?: return null
        if (o.expiresAt <= now()) {
            offer = null
            consumed = false
            return null
        }
        return if (consumed) null else o
    }

    /** A string field that is valid Base64; null when it is missing, not a string or not Base64. */
    private fun base64Field(value: JsonElement?): String? {
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        return try {
            Encoding.fromBase64(text)
            text
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun hello(): HostReply {
        val o = usableOffer() ?: return noPairing()
        return HostReply(
            200,
            buildJsonObject {
                put("sid", o.sid)
                put("mode", o.mode.wire)
            }.toString(),
        )
    }

    private fun start(body: JsonObject): HostReply {
        val sid = base64Field(body["sid"]) ?: return malformed()
        val messageText = base64Field(body["message"]) ?: return malformed()
        val o = usableOffer()
        if (o == null || o.sid != sid) return noPairing()
        // One attempt per code, whatever the outcome.
        consumed = true
        pending = null
        val reply: ByteArray
        val key: ByteArray
        try {
            val cpace = Cpace.start(
                Encoding.utf8(o.code),
                Cpace.PAIRING_CI,
                Encoding.fromBase64(o.sid),
                Encoding.utf8(identity().deviceId),
            )
            key = Pairing.key(Cpace.finish(cpace.state, Encoding.fromBase64(messageText), CpaceRole.RESPONDER))
            reply = cpace.message
        } catch (_: IllegalArgumentException) {
            return fail(400, "pairing failed")
        }
        pending = PendingFinish(o.sid, o.mode, key, now() + PAIRING_FINISH_TTL_MS)
        return HostReply(200, buildJsonObject { put("message", Encoding.toBase64(reply)) }.toString())
    }

    private fun finish(body: JsonObject): HostReply {
        val sid = base64Field(body["sid"]) ?: return malformed()
        val identityBlob = base64Field(body["identity"]) ?: return malformed()
        val vaultInfoElement = body["vaultInfo"]
        val vaultInfoBlob = if (vaultInfoElement == null) null else base64Field(vaultInfoElement) ?: return malformed()
        val p = pending
        if (p == null || p.sid != sid) return noPairing()
        // One attempt per key, whatever the outcome.
        pending = null
        if (p.expiresAt <= now()) return noPairing()
        if ((p.mode == PairingMode.RESTORE) != (vaultInfoBlob != null)) return malformed()

        val peer: DeviceIdentity
        val restored: VaultInfo?
        try {
            peer = Pairing.openIdentity(p.key, CpaceRole.INITIATOR, identityBlob)
            // openVaultInfo also runs Kdf.assertAcceptable.
            restored = vaultInfoBlob?.let { Pairing.openVaultInfo(p.key, CpaceRole.INITIATOR, it) }
        } catch (_: GeneralSecurityException) {
            // Does not open under the key: the extension used another code.
            return fail(403, "pairing failed")
        } catch (_: IllegalArgumentException) {
            return malformed()
        }
        return try {
            onPaired(StoredDevice(peer.deviceId, peer.name, peer.staticPublicKey, now()), restored)
            val own = identity()
            val info = vaultInfo(restored)
            HostReply(
                200,
                buildJsonObject {
                    put("identity", Pairing.sealIdentity(p.key, CpaceRole.RESPONDER, own))
                    put("vaultInfo", Pairing.sealVaultInfo(p.key, CpaceRole.RESPONDER, info))
                }.toString(),
            )
        } catch (e: Exception) {
            reportError(onError, e)
            fail(500, "internal error")
        }
    }
}
