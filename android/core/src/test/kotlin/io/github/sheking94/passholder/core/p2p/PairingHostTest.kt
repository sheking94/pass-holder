package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.KdfParams
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PairingHostTest {
    private val b64 = { n: Int -> Encoding.toBase64(Encoding.randomBytes(n)) }

    private val phoneIdentity = DeviceIdentity("phone-1", "Pixel", b64(32))
    private val extIdentity = DeviceIdentity("ext-1", "Chrome", b64(32))
    private val phoneKdf = KdfParams("argon2id", b64(16), 65536, 3, 4)
    private val phoneEpoch = b64(16)
    private val phoneWrapped = b64(40)
    private val extKdf = KdfParams("argon2id", b64(16), 32768, 4, 2)
    private val extVaultInfo = VaultInfo(b64(16), extKdf, b64(48), listOf("ext-address"))

    private val malformed = """{"error":"malformed request"}"""
    private val noPairing = """{"error":"no pairing"}"""
    private val pairingFailed = """{"error":"pairing failed"}"""

    private inner class Setup {
        var time = 5_000_000L
        val paired = ArrayList<Pair<StoredDevice, VaultInfo?>>()
        var savedKdf: KdfParams? = phoneKdf
        var savedWrapped: String? = phoneWrapped
        var failOnPaired = false
        val errors = ArrayList<Throwable>()
        val host = PairingHost(
            identity = { phoneIdentity },
            vaultInfo = { restored ->
                // The real implementation reads its saved state, which onPaired already updated in restore mode.
                VaultInfo(phoneEpoch, savedKdf!!, savedWrapped!!, listOf("http://192.168.1.5:8787"))
            },
            onPaired = { device, restored ->
                if (failOnPaired) throw IllegalStateException("disk full")
                paired.add(device to restored)
                if (restored != null) {
                    savedKdf = restored.kdf
                    savedWrapped = restored.wrappedVaultKey
                }
            },
            now = { time },
            onError = { errors.add(it) },
        )

        fun post(path: String, body: JsonObject): HostReply = host.handle(path, body)!!

        fun hello(): HostReply = post("/p2p/v1/pair/hello", JsonObject(emptyMap()))

        fun sidOf(reply: HostReply): String =
            ((P2pJson.json.parseToJsonElement(reply.body) as JsonObject)["sid"] as JsonPrimitive).content

        fun startBody(sid: String, code: String) = buildJsonObject {
            put("sid", sid)
            put("message", Encoding.toBase64(Cpace.start(Encoding.utf8(code), Cpace.PAIRING_CI, Encoding.fromBase64(sid), Encoding.utf8("ext-1")).message))
        }
    }

    @Test
    fun `pairing with the right code exchanges identities and vault info`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        assertEquals(8, offer.code.length)
        assertTrue(offer.code.all { it.isDigit() })
        assertEquals(16, Encoding.fromBase64(offer.sid).size)
        assertEquals(s.time + PAIRING_CODE_TTL_MS, offer.expiresAt)
        assertEquals(offer, s.host.current())

        val hello = s.hello()
        assertEquals(200, hello.status)
        assertEquals("""{"sid":"${offer.sid}","mode":"pair"}""", hello.body)

        val result = TestP2pClient.pair(s.host, offer.code, extIdentity)
        assertEquals(200, result.finish!!.status)
        assertEquals(phoneIdentity, result.phoneIdentity)
        assertEquals(VaultInfo(phoneEpoch, phoneKdf, phoneWrapped, listOf("http://192.168.1.5:8787")), result.phoneVaultInfo)
        // The phone's CPace ad is its own deviceId: lv_cat(Yb, adB) ends with it.
        val startMessage = ((P2pJson.json.parseToJsonElement(result.start!!.body) as JsonObject)["message"] as JsonPrimitive).content
        val bytes = Encoding.fromBase64(startMessage)
        val ad = Encoding.utf8("phone-1")
        assertTrue(bytes.copyOfRange(bytes.size - ad.size - 1, bytes.size).contentEquals(byteArrayOf(ad.size.toByte()) + ad))

        assertEquals(1, s.paired.size)
        val (device, restored) = s.paired.single()
        assertEquals(StoredDevice("ext-1", "Chrome", extIdentity.staticPublicKey, s.time), device)
        assertNull(restored)
        // The offer is spent.
        assertNull(s.host.current())
        assertEquals(404, s.hello().status)
    }

    @Test
    fun `a wrong code fails finish with 403 and the sid cannot be retried with the right code`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        val wrong = if (offer.code == "00000000") "00000001" else "00000000"
        val bad = TestP2pClient.pair(s.host, wrong, extIdentity)
        assertEquals(200, bad.start!!.status)
        assertEquals(403, bad.finish!!.status)
        assertEquals(pairingFailed, bad.finish!!.body)
        assertTrue(s.paired.isEmpty())

        val retry = s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code))
        assertEquals(404, retry.status)
        assertEquals(noPairing, retry.body)
    }

    @Test
    fun `a second start after a successful pairing gets 404`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        assertEquals(200, TestP2pClient.pair(s.host, offer.code, extIdentity).finish!!.status)
        assertEquals(404, s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code)).status)
    }

    @Test
    fun `a second start before finish gets 404 and finish is one-shot`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        assertEquals(200, s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code)).status)
        assertEquals(404, s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code)).status)
        assertEquals(404, s.hello().status)

        val finish = buildJsonObject {
            put("sid", offer.sid)
            put("identity", Pairing.sealIdentity(ByteArray(32), CpaceRole.INITIATOR, extIdentity))
        }
        assertEquals(403, s.post("/p2p/v1/pair/finish", finish).status)
        assertEquals(404, s.post("/p2p/v1/pair/finish", finish).status)
    }

    @Test
    fun `the offer expires after the code TTL`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        s.time += 120_000L - 1
        assertEquals(200, s.hello().status)
        s.time += 2 // 120 001 ms after the offer
        assertEquals(404, s.hello().status)
        assertEquals(noPairing, s.hello().body)
        assertNull(s.host.current())
        assertEquals(404, s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code)).status)
    }

    @Test
    fun `finish later than the finish TTL after start gets 404`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        val cpace = Cpace.start(Encoding.utf8(offer.code), Cpace.PAIRING_CI, Encoding.fromBase64(offer.sid), Encoding.utf8("ext-1"))
        val start = s.post(
            "/p2p/v1/pair/start",
            buildJsonObject {
                put("sid", offer.sid)
                put("message", Encoding.toBase64(cpace.message))
            },
        )
        assertEquals(200, start.status)
        val reply = ((P2pJson.json.parseToJsonElement(start.body) as JsonObject)["message"] as JsonPrimitive).content
        val key = Pairing.key(Cpace.finish(cpace.state, Encoding.fromBase64(reply), CpaceRole.INITIATOR))
        s.time += PAIRING_FINISH_TTL_MS + 1
        val finish = s.post(
            "/p2p/v1/pair/finish",
            buildJsonObject {
                put("sid", offer.sid)
                put("identity", Pairing.sealIdentity(key, CpaceRole.INITIATOR, extIdentity))
            },
        )
        assertEquals(404, finish.status)
        assertTrue(s.paired.isEmpty())
    }

    @Test
    fun `restore without vault info gets 400 and does not pair`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.RESTORE)
        assertEquals("""{"sid":"${offer.sid}","mode":"restore"}""", s.hello().body)
        val result = TestP2pClient.pair(s.host, offer.code, extIdentity)
        assertEquals(400, result.finish!!.status)
        assertEquals(malformed, result.finish!!.body)
        assertTrue(s.paired.isEmpty())
    }

    @Test
    fun `restore with a weak KDF gets 400`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.RESTORE)
        val weak = extVaultInfo.copy(kdf = extKdf.copy(memoryKiB = 1024))
        val result = TestP2pClient.pair(s.host, offer.code, extIdentity, weak)
        assertEquals(400, result.finish!!.status)
        assertTrue(s.paired.isEmpty())
    }

    @Test
    fun `restore saves the extension KDF and answers with the phone epoch`() {
        val s = Setup()
        s.savedKdf = null
        s.savedWrapped = null
        val offer = s.host.offer(PairingMode.RESTORE)
        val result = TestP2pClient.pair(s.host, offer.code, extIdentity, extVaultInfo)
        assertEquals(200, result.finish!!.status)
        val (device, restored) = s.paired.single()
        assertEquals("ext-1", device.deviceId)
        assertEquals(extVaultInfo, restored)
        val info = result.phoneVaultInfo!!
        assertEquals(phoneEpoch, info.epoch)
        assertNotEquals(extVaultInfo.epoch, info.epoch)
        assertEquals(extKdf, info.kdf)
        assertEquals(extVaultInfo.wrappedVaultKey, info.wrappedVaultKey)
        assertEquals(listOf("http://192.168.1.5:8787"), info.addresses)
    }

    @Test
    fun `pair mode with an extra vault info gets 400`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        val result = TestP2pClient.pair(s.host, offer.code, extIdentity, extVaultInfo)
        assertEquals(400, result.finish!!.status)
        assertTrue(s.paired.isEmpty())
    }

    @Test
    fun `cancel removes the offer`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        s.host.cancel()
        assertNull(s.host.current())
        assertEquals(404, s.hello().status)
        assertEquals(404, s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code)).status)
    }

    @Test
    fun `cancel drops a pending finish`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        val start = s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code))
        assertEquals(200, start.status)
        s.host.cancel()
        val finish = buildJsonObject {
            put("sid", offer.sid)
            put("identity", Pairing.sealIdentity(ByteArray(32), CpaceRole.INITIATOR, extIdentity))
        }
        assertEquals(404, s.post("/p2p/v1/pair/finish", finish).status)
    }

    @Test
    fun `garbage in the CPace message gets 400 pairing failed and spends the offer`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        val garbage = buildJsonObject {
            put("sid", offer.sid)
            put("message", Encoding.toBase64(ByteArray(40) { 7 }))
        }
        val reply = s.post("/p2p/v1/pair/start", garbage)
        assertEquals(400, reply.status)
        assertEquals(pairingFailed, reply.body)
        assertEquals(404, s.post("/p2p/v1/pair/start", s.startBody(offer.sid, offer.code)).status)
    }

    @Test
    fun `start with another sid gets 404`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        val result = TestP2pClient.pair(s.host, offer.code, extIdentity, sid = b64(16))
        assertEquals(404, result.start!!.status)
        assertEquals(noPairing, result.start!!.body)
    }

    @Test
    fun `hello without an offer gets 404`() {
        val s = Setup()
        assertEquals(404, s.hello().status)
        assertNull(s.host.current())
    }

    @Test
    fun `malformed start and finish bodies get 400`() {
        val s = Setup()
        val offer = s.host.offer(PairingMode.PAIR)
        val bodies = listOf(
            JsonObject(emptyMap()),
            buildJsonObject { put("sid", offer.sid) },
            buildJsonObject { put("sid", 5); put("message", "AAAA") },
            buildJsonObject { put("sid", offer.sid); put("message", "not base64!") },
            buildJsonObject { put("sid", "%%%"); put("message", "AAAA") },
        )
        for (body in bodies) {
            val reply = s.post("/p2p/v1/pair/start", body)
            assertEquals(400, reply.status, body.toString())
            assertEquals(malformed, reply.body)
        }
        val finishBodies = listOf(
            JsonObject(emptyMap()),
            buildJsonObject { put("sid", offer.sid) },
            buildJsonObject { put("sid", offer.sid); put("identity", 1) },
            buildJsonObject { put("sid", offer.sid); put("identity", "AAAA"); put("vaultInfo", 1) },
        )
        for (body in finishBodies) {
            val reply = s.post("/p2p/v1/pair/finish", body)
            assertEquals(400, reply.status, body.toString())
            assertEquals(malformed, reply.body)
        }
        // Malformed requests did not spend the offer.
        assertEquals(200, TestP2pClient.pair(s.host, offer.code, extIdentity).finish!!.status)
    }

    @Test
    fun `an onPaired failure gets 500 and spends the offer`() {
        val s = Setup()
        s.failOnPaired = true
        val offer = s.host.offer(PairingMode.PAIR)
        val result = TestP2pClient.pair(s.host, offer.code, extIdentity)
        assertEquals(500, result.finish!!.status)
        assertEquals(404, s.hello().status)
        // The 500 hides the cause from the extension; the app's log gets it.
        assertEquals(listOf("disk full"), s.errors.map { it.message })
    }

    @Test
    fun `a new offer replaces the old one`() {
        val s = Setup()
        val first = s.host.offer(PairingMode.PAIR)
        val second = s.host.offer(PairingMode.RESTORE)
        assertEquals(second, s.host.current())
        assertEquals(second.sid, s.sidOf(s.hello()))
        assertEquals(404, s.post("/p2p/v1/pair/start", s.startBody(first.sid, first.code)).status)
    }

    @Test
    fun `other paths are not handled`() {
        val s = Setup()
        assertNull(s.host.handle("/p2p/v1/sync", JsonObject(emptyMap())))
        assertNull(s.host.handle("/p2p/v1/pair/other", JsonObject(emptyMap())))
        assertNotNull(s.host.handle("/p2p/v1/pair/hello", JsonObject(emptyMap())))
    }
}
