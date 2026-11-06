package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PhoneRouterTest {
    private val phone = DeviceIdentity("phone", "Telefon", Encoding.toBase64(NoiseKeys.generate().publicKey))
    private val pairing = PairingHost({ phone }, { error("not used") }, { _, _ -> })

    private fun post(router: PhoneRouter, path: String, body: String = "{}") = router.handle(path, body.toByteArray())

    @Test
    fun answersPing() {
        val router = PhoneRouter(pairing, { null }, {})
        assertEquals(HostReply(200, """{"ok":true}"""), post(router, "/p2p/v1/ping"))
    }

    @Test
    fun unknownPathIs404EvenWithABadBody() {
        val router = PhoneRouter(pairing, { null }, {})
        assertEquals(HostReply(404, """{"error":"not found"}"""), post(router, "/p2p/v1/nope", "[1]"))
        assertEquals(404, post(router, "/", "{}").status)
    }

    @Test
    fun bodyThatIsNotAJsonObjectIs400() {
        val router = PhoneRouter(pairing, { null }, {})
        val malformed = HostReply(400, """{"error":"malformed request"}""")
        assertEquals(malformed, post(router, "/p2p/v1/ping", "[]"))
        assertEquals(malformed, post(router, "/p2p/v1/pair/hello", "not json"))
        assertEquals(malformed, router.handle("/p2p/v1/handshake", byteArrayOf(0xff.toByte(), 0xfe.toByte())))
        assertEquals(malformed, post(router, "/p2p/v1/sync", "\"x\""))
    }

    @Test
    fun handshakeAndSyncAre503WithoutAHost() {
        val router = PhoneRouter(pairing, { null }, {})
        val notReady = HostReply(503, """{"error":"vault not ready"}""")
        assertEquals(notReady, post(router, "/p2p/v1/handshake"))
        assertEquals(notReady, post(router, "/p2p/v1/sync"))
    }

    @Test
    fun pairingPathsGoToThePairingHost() {
        val router = PhoneRouter(pairing, { null }, {})
        assertEquals(HostReply(404, """{"error":"no pairing"}"""), post(router, "/p2p/v1/pair/hello"))
        val offer = pairing.offer(PairingMode.PAIR)
        assertEquals(200, post(router, "/p2p/v1/pair/hello").status)
        assertEquals(400, post(router, "/p2p/v1/pair/start", """{"sid":"${offer.sid}"}""").status)
    }

    @Test
    fun handshakeAndSyncGoToTheHost() {
        val hostKey = NoiseKeys.generate()
        val key = NoiseKeys.generate()
        val epoch = Encoding.toBase64(Encoding.randomBytes(16))
        val host = P2pHost(hostKey, { listOf(PairedDevice("a", "a", key.publicKey)) }, MemorySyncStore(), epoch, { emptyList() })
        val router = PhoneRouter(pairing, { host }, {})
        val client = TestP2pClient("a", key, hostKey.publicKey, router::handle)
        assertEquals(epoch, client.syncResponse(P2pSyncRequest(epoch, 0, emptyList())).epoch)
    }

    @Test
    fun everyRequestToAKnownPathCallsOnRequest() {
        var count = 0
        val router = PhoneRouter(pairing, { null }, { count++ })
        post(router, "/p2p/v1/ping")
        post(router, "/p2p/v1/ping", "[]")
        post(router, "/p2p/v1/handshake")
        post(router, "/p2p/v1/pair/hello")
        assertEquals(4, count)
        // A scanner probing unknown paths does not keep sync mode awake.
        post(router, "/p2p/v1/nope")
        post(router, "/")
        post(router, "/index.html", "[]")
        assertEquals(4, count)
    }

    @Test
    fun hostFailureIs500() {
        val router = PhoneRouter(pairing, { throw IllegalStateException("Corrupt host state") }, {})
        assertEquals(HostReply(500, """{"error":"internal error"}"""), post(router, "/p2p/v1/handshake"))
    }

    @Test
    fun syncConstants() {
        assertEquals(8787, PhoneSync.PORT)
        assertEquals(300_000L, PhoneSync.SYNC_IDLE_MS)
    }
}
