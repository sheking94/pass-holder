package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.ChangeRequest
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.RemoteRecord
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.Callable
import java.util.concurrent.Executors

class P2pHostTest {
    private val blob = Encoding.toBase64(Encoding.randomBytes(40))

    private inner class Setup {
        val store = MemorySyncStore()
        val epoch = Encoding.toBase64(Encoding.randomBytes(16))
        val hostKey = NoiseKeys.generate()
        val devices = ArrayList<PairedDevice>()
        var time = 1_000_000L
        val host = P2pHost(hostKey, { devices.toList() }, store, epoch, { listOf("192.168.1.5:8787") }, { time })

        fun addDevice(deviceId: String): KeyPair {
            val key = NoiseKeys.generate()
            devices.add(PairedDevice(deviceId, deviceId, key.publicKey))
            return key
        }

        fun client(deviceId: String, key: KeyPair = addDevice(deviceId)) =
            TestP2pClient(deviceId, key, hostKey.publicKey, host)

        fun post(path: String, body: String) = host.handle(path, body.toByteArray())

        fun handshakeBody(deviceId: String, key: KeyPair): String {
            val noise = NoiseKK.initiator(key, hostKey.publicKey, P2P_PROLOGUE)
            return """{"deviceId":"$deviceId","message":"${Encoding.toBase64(noise.writeMessage(ByteArray(0)))}"}"""
        }

        /** Handshake by hand; returns the session id and the client ciphers. */
        fun rawHandshake(deviceId: String, key: KeyPair = addDevice(deviceId)): Pair<String, TransportCiphers> {
            val noise = NoiseKK.initiator(key, hostKey.publicKey, P2P_PROLOGUE)
            val message = Encoding.toBase64(noise.writeMessage(ByteArray(0)))
            val res = post("/p2p/v2/handshake", """{"deviceId":"$deviceId","message":"$message"}""")
            assertEquals(200, res.status)
            val obj = P2pJson.json.parseToJsonElement(res.body) as JsonObject
            noise.readMessage(Encoding.fromBase64((obj["message"] as JsonPrimitive).content))
            return (obj["session"] as JsonPrimitive).content to noise.split()
        }

        fun syncBody(session: String, frames: List<String>): String = buildJsonObject {
            put("session", session)
            put("frames", JsonArray(frames.map { JsonPrimitive(it) }))
        }.toString()

        fun emptyRequest() = """{"epoch":"$epoch","sinceRevision":0,"changes":[]}"""

        /** Sends [request] (raw JSON) on a fresh session of a newly added device. */
        fun sendRaw(request: String): HostReply {
            val id = "d${devices.size}"
            val (session, ciphers) = rawHandshake(id)
            return post("/p2p/v2/sync", syncBody(session, Frames.encrypt(ciphers.send, request)))
        }
    }

    private fun assertError(status: Int, text: String, res: HostReply) {
        assertEquals(status, res.status, res.body)
        assertEquals("""{"error":"$text"}""", res.body)
    }

    private fun change(id: String, base: Long = 0) = """{"id":"$id","baseRevision":$base,"deleted":false,"blob":"$blob"}"""
    private fun req(epoch: String, since: Long, vararg changes: String) =
        """{"epoch":"$epoch","sinceRevision":$since,"changes":[${changes.joinToString(",")}]}"""

    @Test
    fun syncsClientsThroughTheHost() {
        val s = Setup()
        val res = s.client("a").syncResponse(P2pSyncRequest(s.epoch, 0, listOf(ChangeRequest("x", 0, false, blob))))
        assertEquals(s.epoch, res.epoch)
        assertEquals(1, res.accepted.size)
        assertEquals(listOf("192.168.1.5:8787"), res.addresses)
        assertEquals(RemoteRecord("x", 1, false, blob), s.store.get("x"))
        val second = s.client("b").syncResponse(P2pSyncRequest(s.epoch, 0, emptyList()))
        assertEquals(listOf(RemoteRecord("x", 1, false, blob)), second.changes)
    }

    @Test
    fun refusesUnpairedAndRemovedDevices() {
        val s = Setup()
        val stranger = TestP2pClient("nobody", NoiseKeys.generate(), s.hostKey.publicKey, s.host)
        assertTrue(runCatching { stranger.handshake() }.exceptionOrNull()!!.message!!.contains("403"))
        assertError(403, "device not paired", s.post("/p2p/v2/handshake", s.handshakeBody("nobody", NoiseKeys.generate())))

        val client = s.client("a")
        assertEquals(s.epoch, client.syncResponse(P2pSyncRequest(s.epoch, 0, emptyList())).epoch)
        s.devices.clear()
        assertTrue(runCatching { client.handshake() }.exceptionOrNull()!!.message!!.contains("403"))
    }

    @Test
    fun rejectsReusedExpiredAndUnknownSessions() {
        val s = Setup()
        val key = s.addDevice("a")
        val (session, ciphers) = s.rawHandshake("a", key)
        val frames = Frames.encrypt(ciphers.send, s.emptyRequest())
        assertEquals(200, s.post("/p2p/v2/sync", s.syncBody(session, frames)).status)
        assertError(401, "unknown or expired session", s.post("/p2p/v2/sync", s.syncBody(session, frames)))

        val (second, ciphers2) = s.rawHandshake("a", key)
        s.time += 61_000
        val expired = s.post("/p2p/v2/sync", s.syncBody(second, Frames.encrypt(ciphers2.send, s.emptyRequest())))
        assertError(401, "unknown or expired session", expired)

        val unknown = Encoding.toBase64(Encoding.randomBytes(16))
        assertError(401, "unknown or expired session", s.post("/p2p/v2/sync", s.syncBody(unknown, listOf("AA=="))))
    }

    @Test
    fun sessionExpiresExactlyAtTheTtl() {
        val s = Setup()
        val (session, ciphers) = s.rawHandshake("a")
        s.time += P2pHost.SESSION_TTL_MS
        val res = s.post("/p2p/v2/sync", s.syncBody(session, Frames.encrypt(ciphers.send, s.emptyRequest())))
        assertEquals(401, res.status)
    }

    @Test
    fun sessionIdsAre16RandomBytes() {
        val s = Setup()
        val key = s.addDevice("a")
        val ids = (1..5).map { s.rawHandshake("a", key).first }
        assertEquals(5, ids.toSet().size)
        ids.forEach { assertEquals(16, Encoding.fromBase64(it).size) }
    }

    @Test
    fun rejectsATamperedSyncCiphertext() {
        val s = Setup()
        val (session, ciphers) = s.rawHandshake("a")
        val ct = Encoding.fromBase64(Frames.encrypt(ciphers.send, s.emptyRequest())[0])
        ct[ct.size - 1] = (ct[ct.size - 1].toInt() xor 1).toByte()
        val res = s.post("/p2p/v2/sync", s.syncBody(session, listOf(Encoding.toBase64(ct))))
        assertError(400, "cannot decrypt request", res)
        assertEquals(0, s.store.currentRevision())
    }

    @Test
    fun syncsARequestOver200KiBAcrossManyFrames() {
        val s = Setup()
        val big = Encoding.toBase64(Encoding.randomBytes(300))
        val changes = (0 until 500).map { """{"id":"id$it","baseRevision":0,"deleted":false,"blob":"$big"}""" }
        val request = req(s.epoch, 0, *changes.toTypedArray())
        assertTrue(request.length > 200 * 1024)
        val (session, ciphers) = s.rawHandshake("a")
        val frames = Frames.encrypt(ciphers.send, request)
        assertTrue(frames.size > 2)
        val res = s.post("/p2p/v2/sync", s.syncBody(session, frames))
        assertEquals(200, res.status, res.body)
        assertEquals(500, s.store.currentRevision())
    }

    @Test
    fun rejectsATamperedMiddleFrameAndLeavesTheStoreUnchanged() {
        val s = Setup()
        val (session, ciphers) = s.rawHandshake("a")
        val junk = "z".repeat(400)
        val changes = (0 until 400).map { """{"id":"x$it","junk":"$junk"}""" }
        val frames = Frames.encrypt(ciphers.send, req(s.epoch, 0, *changes.toTypedArray())).toMutableList()
        assertTrue(frames.size > 2)
        val mid = Encoding.fromBase64(frames[1])
        mid[5] = (mid[5].toInt() xor 1).toByte()
        frames[1] = Encoding.toBase64(mid)
        assertError(400, "cannot decrypt request", s.post("/p2p/v2/sync", s.syncBody(session, frames)))
        assertEquals(0, s.store.currentRevision())
    }

    @Test
    fun rejectsAnOversizedBodyBeforeAnythingElse() {
        val s = Setup()
        val big = ByteArray(P2pHost.MAX_BODY_BYTES + 1) { 'A'.code.toByte() }
        assertError(413, "body too large", s.host.handle("/p2p/v2/sync", big))
        assertError(413, "body too large", s.host.handle("/nope", big))
        // Exactly the limit passes the size check and fails later.
        val ok = ByteArray(P2pHost.MAX_BODY_BYTES) { 'A'.code.toByte() }
        assertError(400, "malformed request", s.host.handle("/p2p/v2/sync", ok))
    }

    @Test
    fun mapsMalformedRequestsAndUnknownPaths() {
        val s = Setup()
        assertError(404, "not found", s.post("/p2p/v1/nope", "{}"))
        assertError(400, "malformed request", s.post("/p2p/v2/handshake", """{"deviceId":1}"""))
        assertError(400, "malformed request", s.post("/p2p/v2/sync", "null"))
        s.addDevice("a")
        val garbage = Encoding.toBase64(Encoding.randomBytes(48))
        assertError(400, "handshake failed", s.post("/p2p/v2/handshake", """{"deviceId":"a","message":"$garbage"}"""))
        assertError(400, "handshake failed", s.post("/p2p/v2/handshake", """{"deviceId":"a","message":""}"""))
        assertError(400, "malformed request", s.post("/p2p/v2/handshake", """{"deviceId":"a","message":"***"}"""))
    }

    @Test
    fun handshakeFromAnotherKeyFails() {
        val s = Setup()
        s.addDevice("a")
        assertError(400, "handshake failed", s.post("/p2p/v2/handshake", s.handshakeBody("a", NoiseKeys.generate())))
    }

    @Test
    fun aStoredDeviceKeyOfTheWrongLengthIsAHandshakeFailureNotAnException() {
        val s = Setup()
        val key = NoiseKeys.generate()
        s.devices.add(PairedDevice("a", "a", ByteArray(31)))
        assertError(400, "handshake failed", s.post("/p2p/v2/handshake", s.handshakeBody("a", key)))
    }

    @Test
    fun badSyncShapesAre400() {
        val s = Setup()
        val frames18 = (1..18).joinToString(",") { "\"AA==\"" }
        val frames19 = (1..19).joinToString(",") { "\"AA==\"" }
        val bad = listOf(
            """{"frames":["AA=="]}""",
            """{"session":"x"}""",
            """{"session":1,"frames":["AA=="]}""",
            """{"session":"x","frames":[]}""",
            """{"session":"x","frames":[1]}""",
            """{"session":"x","frames":"AA=="}""",
            """{"session":"x","frames":[$frames19]}""",
        )
        for (b in bad) assertError(400, "malformed request", s.post("/p2p/v2/sync", b))
        // 18 frames is within the limit, so an unknown session is a 401.
        assertEquals(401, s.post("/p2p/v2/sync", """{"session":"x","frames":[$frames18]}""").status)
    }

    @Test
    fun nonObjectOrNonUtf8BodiesAreMalformedOnBothPaths() {
        val s = Setup()
        val bodies = listOf(
            byteArrayOf(0xff.toByte(), 0xfe.toByte()),
            "[]".toByteArray(),
            "{".toByteArray(),
            "null".toByteArray(),
            ByteArray(0),
            "\"text\"".toByteArray(),
        )
        for (path in listOf("/p2p/v2/handshake", "/p2p/v2/sync")) {
            for (b in bodies) assertError(400, "malformed request", s.host.handle(path, b))
        }
    }

    @Test
    fun aSessionOpenedBeforeTheDeviceWasRemovedCannotSync() {
        val s = Setup()
        val key = s.addDevice("a")
        val (session, ciphers) = s.rawHandshake("a", key)
        s.devices.clear()
        val frames = Frames.encrypt(ciphers.send, s.emptyRequest())
        assertError(403, "device not paired", s.post("/p2p/v2/sync", s.syncBody(session, frames)))
        // The session is consumed even though the device comes back.
        s.devices.add(PairedDevice("a", "a", key.publicKey))
        assertEquals(401, s.post("/p2p/v2/sync", s.syncBody(session, frames)).status)
    }

    @Test
    fun aSessionOpenedBeforeRePairingWithAnotherKeyCannotSync() {
        val s = Setup()
        val (session, ciphers) = s.rawHandshake("a")
        s.devices[0] = PairedDevice("a", "a", NoiseKeys.generate().publicKey)
        val res = s.post("/p2p/v2/sync", s.syncBody(session, Frames.encrypt(ciphers.send, s.emptyRequest())))
        assertError(403, "device not paired", res)
    }

    @Test
    fun theSessionKeepsItsOwnCopyOfTheStaticKey() {
        val s = Setup()
        val (session, ciphers) = s.rawHandshake("a")
        // Changing the stored array in place afterwards must not make the session match a different key.
        s.devices[0].staticPublicKey.fill(0)
        val res = s.post("/p2p/v2/sync", s.syncBody(session, Frames.encrypt(ciphers.send, s.emptyRequest())))
        assertEquals(403, res.status)
    }

    @Test
    fun invalidRequestsAre400AndLeaveTheStoreUnchanged() {
        val s = Setup()
        val bad = listOf(
            listOf(change("ok"), """{"id":1,"baseRevision":0,"deleted":false,"blob":"$blob"}"""),
            listOf(change("ok"), change("")),
            listOf(change("ok"), change("x".repeat(129))),
            listOf(change("ok"), change("x", -1)),
            listOf(change("ok"), """{"id":"x","baseRevision":1.5,"deleted":false,"blob":"$blob"}"""),
            listOf(change("ok"), """{"id":"x","baseRevision":0,"deleted":"no","blob":"$blob"}"""),
            listOf(change("ok"), """{"id":"x","baseRevision":0,"deleted":false,"blob":1}"""),
            listOf(change("ok"), "null"),
            listOf(change("ok"), change("ok")),
        )
        for (changes in bad) {
            val res = s.sendRaw(req(s.epoch, 0, *changes.toTypedArray()))
            assertEquals(400, res.status, changes.toString())
            assertEquals(0, s.store.currentRevision())
        }
        assertEquals(400, s.sendRaw(req(s.epoch, -1)).status)
        assertEquals(200, s.sendRaw(req(s.epoch, 0, change("x".repeat(128)))).status)
    }

    @Test
    fun validationTextIsTheErrorBody() {
        val s = Setup()
        assertError(400, "duplicate change", s.sendRaw(req(s.epoch, 0, change("a"), change("a"))))
        assertError(400, "malformed sync request", s.sendRaw("[]"))
    }

    @Test
    fun anUnknownBaseRevisionIs400BeforeAnyWrite() {
        val s = Setup()
        assertError(400, "unknown base revision", s.sendRaw(req(s.epoch, 0, change("a"), change("ghost", 5))))
        assertEquals(0, s.store.currentRevision())
        // From another epoch nothing is processed, so the base revision does not matter.
        assertEquals(200, s.sendRaw(req("", 0, change("ghost", 5))).status)
    }

    @Test
    fun aFailureWhileBuildingTheResponseIs500() {
        val s = Setup()
        val key = s.addDevice("a")
        val errors = ArrayList<Throwable>()
        val failing = P2pHost(
            s.hostKey, { s.devices.toList() }, s.store, s.epoch, { error("boom") }, { s.time }, onError = { errors.add(it) },
        )
        val client = TestP2pClient("a", key, s.hostKey.publicKey, failing)
        assertError(500, "internal error", client.sync(s.emptyRequest()))
        assertEquals(listOf("boom"), errors.map { it.message })
    }

    @Test
    fun aRestoredPhoneAnswersEmptyAndReportsItsRevision() {
        val s = Setup()
        s.store.put(RemoteRecord("known", 1, false, blob))
        val client = s.client("ext")
        val ahead = client.syncResponse(
            P2pSyncRequest(s.epoch, 5, listOf(ChangeRequest("ghost", 3, false, blob), ChangeRequest("fresh", 0, false, blob))),
        )
        assertEquals(
            P2pSyncResponse(s.epoch, 1, emptyList(), emptyList(), emptyList(), listOf("192.168.1.5:8787"), false),
            ahead,
        )
        assertEquals(1, s.store.currentRevision())
        assertNull(s.store.get("fresh"))
        // The client then starts over from 0 and receives everything.
        val restart = client.syncResponse(P2pSyncRequest(s.epoch, 0, listOf(ChangeRequest("fresh", 0, false, blob))))
        assertEquals(2, restart.currentRevision)
        assertEquals(listOf(RemoteRecord("known", 1, false, blob)), restart.changes)
    }

    @Test
    fun holdsAtMost32LiveSessionsAndAnswers503WhenFull() {
        val s = Setup()
        val key = s.addDevice("a")
        repeat(P2pHost.MAX_SESSIONS) { s.rawHandshake("a", key) }
        assertError(503, "too many sessions", s.post("/p2p/v2/handshake", s.handshakeBody("a", key)))
        // The pairing check comes first.
        assertError(403, "device not paired", s.post("/p2p/v2/handshake", s.handshakeBody("nobody", key)))
        s.time += 61_000
        s.rawHandshake("a", key)
    }

    @Test
    fun aUsedSessionFreesItsSlot() {
        val s = Setup()
        val key = s.addDevice("a")
        val sessions = (1..P2pHost.MAX_SESSIONS).map { s.rawHandshake("a", key) }
        val (id, ciphers) = sessions.first()
        s.post("/p2p/v2/sync", s.syncBody(id, Frames.encrypt(ciphers.send, s.emptyRequest())))
        s.rawHandshake("a", key)
    }

    @Test
    fun handlesConcurrentCallsFromManyThreads() {
        val s = Setup()
        val clients = (0 until 8).map { s.client("d$it") }
        val pool = Executors.newFixedThreadPool(8)
        try {
            val tasks = clients.mapIndexed { i, c ->
                Callable {
                    repeat(5) { j ->
                        c.syncResponse(P2pSyncRequest(s.epoch, 0, listOf(ChangeRequest("c$i-$j", 0, false, blob))))
                    }
                }
            }
            pool.invokeAll(tasks).forEach { it.get() }
        } finally {
            pool.shutdown()
        }
        assertEquals(40, s.store.currentRevision())
    }

    @Test
    fun callsOnSyncedOnlyAfterASuccessfulSync() {
        val store = MemorySyncStore()
        val epoch = Encoding.toBase64(Encoding.randomBytes(16))
        val hostKey = NoiseKeys.generate()
        val key = NoiseKeys.generate()
        val synced = ArrayList<String>()
        val host = P2pHost(
            hostKey, { listOf(PairedDevice("a", "a", key.publicKey)) }, store, epoch, { emptyList() },
            onSynced = { synced.add(it) },
        )
        val client = TestP2pClient("a", key, hostKey.publicKey, host)
        client.syncResponse(P2pSyncRequest(epoch, 0, emptyList()))
        assertEquals(listOf("a"), synced)
        // A request the host rejects (unknown base revision) is not a sync.
        assertEquals(400, client.sync(req(epoch, 0, change("x", 5))).status)
        client.handshake()
        assertEquals(listOf("a"), synced)
    }

    @Test
    fun failingOnSyncedStillAnswers200() {
        val errors = ArrayList<Throwable>()
        val store = MemorySyncStore()
        val epoch = Encoding.toBase64(Encoding.randomBytes(16))
        val hostKey = NoiseKeys.generate()
        val key = NoiseKeys.generate()
        val host = P2pHost(
            hostKey, { listOf(PairedDevice("a", "a", key.publicKey)) }, store, epoch, { emptyList() },
            onSynced = { throw IllegalStateException("disk full") },
            onError = { errors.add(it) },
        )
        val client = TestP2pClient("a", key, hostKey.publicKey, host)
        val res = client.syncResponse(P2pSyncRequest(epoch, 0, listOf(ChangeRequest("x", 0, false, blob))))
        assertEquals(1, res.accepted.size)
        assertEquals(1, store.currentRevision())
        assertEquals(listOf("disk full"), errors.map { it.message })
    }

    @Test
    fun oldPathsAnswer410() {
        val s = Setup()
        val gone = HostReply(410, """{"error":"update required"}""")
        assertEquals(gone, s.post("/p2p/v1/handshake", "{}"))
        assertEquals(gone, s.post("/p2p/v1/sync", "{}"))
        assertError(404, "not found", s.post("/p2p/v3/sync", "{}"))
    }
}
