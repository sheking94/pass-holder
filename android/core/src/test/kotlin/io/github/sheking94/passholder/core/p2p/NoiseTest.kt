package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.ErrorCode
import io.github.sheking94.passholder.core.assertCode
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

@Serializable
private data class NoiseVectorMessage(val payload: String, val ciphertext: String)

@Serializable
private data class NoiseVector(
    val protocol_name: String,
    val init_prologue: String,
    val init_static: String,
    val init_ephemeral: String,
    val init_remote_static: String,
    val resp_prologue: String,
    val resp_static: String,
    val resp_ephemeral: String,
    val resp_remote_static: String,
    val handshake_hash: String,
    val messages: List<NoiseVectorMessage>,
)

private val noiseJson = Json { ignoreUnknownKeys = true }

class NoiseTest {
    private val empty = ByteArray(0)
    private fun utf8(s: String) = Encoding.utf8(s)
    private fun hex(b: ByteArray) = Encoding.toHex(b)
    private fun unhex(s: String) = Encoding.fromHex(s)

    private val raw: NoiseVector = noiseJson.decodeFromString(
        File(System.getProperty("passholder.repoRoot"), "core/test-vectors/noise-kk.json").readText(),
    )

    private fun pair() = NoiseKeys.generate() to NoiseKeys.generate()

    private fun handshake(prologue: ByteArray = P2P_PROLOGUE): Pair<NoiseKK, NoiseKK> {
        val (a, b) = pair()
        val init = NoiseKK.initiator(a, b.publicKey, prologue)
        val resp = NoiseKK.responder(b, a.publicKey, prologue)
        assertArrayEquals(utf8("hello"), resp.readMessage(init.writeMessage(utf8("hello"))))
        assertArrayEquals(utf8("world"), init.readMessage(resp.writeMessage(utf8("world"))))
        return init to resp
    }

    private fun mk(): Pair<NoiseKK, NoiseKK> {
        val (a, b) = pair()
        return NoiseKK.initiator(a, b.publicKey, P2P_PROLOGUE) to NoiseKK.responder(b, a.publicKey, P2P_PROLOGUE)
    }

    @Test
    fun usesPassholderPrologue() {
        assertArrayEquals(utf8("passholder/v2/noise"), P2P_PROLOGUE)
    }

    @Test
    fun reproducesCacophonyKkVector() {
        assertEquals("Noise_KK_25519_AESGCM_SHA256", raw.protocol_name)
        val initS = NoiseKeys.fromPrivateKey(unhex(raw.init_static))
        val respS = NoiseKeys.fromPrivateKey(unhex(raw.resp_static))
        assertEquals(raw.init_remote_static, hex(respS.publicKey))
        assertEquals(raw.resp_remote_static, hex(initS.publicKey))

        val init = NoiseKK.initiator(
            initS,
            unhex(raw.init_remote_static),
            unhex(raw.init_prologue),
            NoiseKeys.fromPrivateKey(unhex(raw.init_ephemeral)),
        )
        val resp = NoiseKK.responder(
            respS,
            unhex(raw.resp_remote_static),
            unhex(raw.resp_prologue),
            NoiseKeys.fromPrivateKey(unhex(raw.resp_ephemeral)),
        )
        val (h1, h2) = raw.messages
        val transport = raw.messages.drop(2)

        val m1 = init.writeMessage(unhex(h1.payload))
        assertEquals(h1.ciphertext, hex(m1))
        assertEquals(h1.payload, hex(resp.readMessage(m1)))
        val m2 = resp.writeMessage(unhex(h2.payload))
        assertEquals(h2.ciphertext, hex(m2))
        assertEquals(h2.payload, hex(init.readMessage(m2)))

        assertEquals(raw.handshake_hash, hex(init.handshakeHash))
        assertEquals(raw.handshake_hash, hex(resp.handshakeHash))

        val i = init.split()
        val r = resp.split()
        assertEquals(4, transport.size)
        transport.forEachIndexed { k, m ->
            val (sender, receiver) = if (k % 2 == 0) i to r else r to i
            val ct = sender.send.encrypt(empty, unhex(m.payload))
            assertEquals(m.ciphertext, hex(ct))
            assertEquals(m.payload, hex(receiver.recv.decrypt(empty, ct)))
        }
    }

    @Test
    fun bothSidesDeriveMatchingTransportKeys() {
        val (init, resp) = handshake()
        assertArrayEquals(init.handshakeHash, resp.handshakeHash)
        val i = init.split()
        val r = resp.split()
        val ad = utf8("passholder/v2/test")
        for (n in 0 until 3) {
            val ping = i.send.encrypt(ad, utf8("ping $n"))
            assertArrayEquals(utf8("ping $n"), r.recv.decrypt(ad, ping))
            val pong = r.send.encrypt(ad, utf8("pong $n"))
            assertArrayEquals(utf8("pong $n"), i.recv.decrypt(ad, pong))
        }
        val own = i.send.encrypt(ad, utf8("x"))
        assertCode(ErrorCode.NOISE_FAILED) { i.recv.decrypt(ad, own) }
    }

    @Test
    fun rejectsTamperedMessage1AndFailsFurtherSteps() {
        for (index in listOf(0, 40)) {
            val (init, resp) = mk()
            val m1 = init.writeMessage(utf8("hello"))
            m1[index] = (m1[index].toInt() xor 1).toByte()
            assertCode(ErrorCode.NOISE_FAILED) { resp.readMessage(m1) }
            assertCode(ErrorCode.NOISE_FAILED) { resp.writeMessage(utf8("x")) }
            assertCode(ErrorCode.NOISE_FAILED) { resp.split() }
            assertCode(ErrorCode.NOISE_FAILED) { resp.handshakeHash }
        }
    }

    @Test
    fun rejectsTruncatedMessage1() {
        val (init, resp) = mk()
        val m1 = init.writeMessage(utf8("hello"))
        assertCode(ErrorCode.NOISE_FAILED) { resp.readMessage(m1.copyOf(20)) }
        val (init2, resp2) = mk()
        val n1 = init2.writeMessage(utf8("hello"))
        assertCode(ErrorCode.NOISE_FAILED) { resp2.readMessage(n1.copyOf(n1.size - 1)) }
    }

    @Test
    fun rejectsTamperedAndTruncatedMessage2() {
        for (index in listOf(0, 40)) {
            val (init, resp) = mk()
            resp.readMessage(init.writeMessage(utf8("hello")))
            val m2 = resp.writeMessage(utf8("world"))
            m2[index] = (m2[index].toInt() xor 1).toByte()
            assertCode(ErrorCode.NOISE_FAILED) { init.readMessage(m2) }
            assertCode(ErrorCode.NOISE_FAILED) { init.split() }
            assertCode(ErrorCode.NOISE_FAILED) { init.readMessage(m2) }
        }
        val (init, resp) = mk()
        resp.readMessage(init.writeMessage(utf8("hello")))
        val m2 = resp.writeMessage(utf8("world"))
        assertCode(ErrorCode.NOISE_FAILED) { init.readMessage(m2.copyOf(m2.size - 1)) }
        val (init2, resp2) = mk()
        resp2.readMessage(init2.writeMessage(utf8("hello")))
        val n2 = resp2.writeMessage(utf8("world"))
        assertCode(ErrorCode.NOISE_FAILED) { init2.readMessage(n2.copyOf(20)) }
    }

    @Test
    fun rejectsReplayedTransportFrame() {
        val (init, resp) = handshake()
        val i = init.split()
        val r = resp.split()
        val frame = i.send.encrypt(empty, utf8("sync"))
        assertArrayEquals(utf8("sync"), r.recv.decrypt(empty, frame))
        assertCode(ErrorCode.NOISE_FAILED) { r.recv.decrypt(empty, frame) }
    }

    @Test
    fun failsWhenResponderExpectsDifferentInitiatorKey() {
        val (a, b) = pair()
        val stranger = NoiseKeys.generate()
        val init = NoiseKK.initiator(a, b.publicKey, P2P_PROLOGUE)
        val resp = NoiseKK.responder(b, stranger.publicKey, P2P_PROLOGUE)
        assertCode(ErrorCode.NOISE_FAILED) { resp.readMessage(init.writeMessage(utf8("hi"))) }
    }

    @Test
    fun failsWhenPrologueDiffers() {
        val (a, b) = pair()
        val init = NoiseKK.initiator(a, b.publicKey, P2P_PROLOGUE)
        val resp = NoiseKK.responder(b, a.publicKey, utf8("other"))
        assertCode(ErrorCode.NOISE_FAILED) { resp.readMessage(init.writeMessage(utf8("hi"))) }
    }

    @Test
    fun enforcesOrderSplitTimingAndSizeLimit() {
        val (a, b) = pair()
        val init = NoiseKK.initiator(a, b.publicKey, P2P_PROLOGUE)
        val resp = NoiseKK.responder(b, a.publicKey, P2P_PROLOGUE)
        assertCode(ErrorCode.NOISE_FAILED) { init.split() }
        assertCode(ErrorCode.NOISE_FAILED) { resp.writeMessage(utf8("x")) }
        assertCode(ErrorCode.NOISE_FAILED) { init.readMessage(ByteArray(48)) }
        val tooBig = assertCode(ErrorCode.NOISE_FAILED) { init.writeMessage(ByteArray(65535 - 48 + 1)) }
        assertTrue(tooBig.message!!.contains("65535"))
        val tooBigRead = assertCode(ErrorCode.NOISE_FAILED) { resp.readMessage(ByteArray(65536)) }
        assertTrue(tooBigRead.message!!.contains("65535"))
        // Size errors leave the state intact.
        val m1 = init.writeMessage(ByteArray(65535 - 48))
        assertEquals(65535, m1.size)
        resp.readMessage(m1)
        assertCode(ErrorCode.NOISE_FAILED) { resp.split() }
        init.readMessage(resp.writeMessage(empty))
        assertCode(ErrorCode.NOISE_FAILED) { init.writeMessage(utf8("x")) }
        val send = init.split().send
        val big = assertCode(ErrorCode.NOISE_FAILED) { send.encrypt(empty, ByteArray(65535 - 16 + 1)) }
        assertTrue(big.message!!.contains("65535"))
        assertCode(ErrorCode.NOISE_FAILED) { init.split() }
    }

    @Test
    fun rejectsAllZeroPublicKey() {
        val (a, b) = pair()
        val init = NoiseKK.initiator(a, ByteArray(32), P2P_PROLOGUE)
        val e = assertCode(ErrorCode.NOISE_FAILED) { init.writeMessage(empty) }
        assertEquals("Noise: invalid public key", e.message)
        val resp = NoiseKK.responder(b, a.publicKey, P2P_PROLOGUE)
        val e2 = assertCode(ErrorCode.NOISE_FAILED) { resp.readMessage(ByteArray(48)) }
        assertEquals("Noise: invalid public key", e2.message)
    }

    @Test
    fun keyPairFromPrivateKeyChecksLength() {
        assertCode(ErrorCode.NOISE_FAILED) { NoiseKeys.fromPrivateKey(ByteArray(31)) }
    }
}

class CipherStateTest {
    private val empty = ByteArray(0)
    private fun utf8(s: String) = Encoding.utf8(s)

    @Test
    fun passesPlaintextThroughWithoutKey() {
        val cs = CipherState(null)
        assertFalse(cs.hasKey())
        assertArrayEquals(utf8("plain"), cs.encrypt(empty, utf8("plain")))
        assertArrayEquals(utf8("plain"), cs.decrypt(empty, utf8("plain")))
    }

    @Test
    fun usesFourZeroBytesAndBigEndianCounterAsNonce() {
        val key = ByteArray(32) { 7 }
        val cs = CipherState(key, 0x0102030405060708uL)
        val ad = utf8("ad")
        val ct = cs.encrypt(ad, utf8("msg"))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, Encoding.fromHex("000000000102030405060708")),
        )
        cipher.updateAAD(ad)
        assertArrayEquals(cipher.doFinal(utf8("msg")), ct)
    }

    @Test
    fun refusesNonceMax() {
        val key = ByteArray(32) { 1 }
        val last = CipherState(key, ULong.MAX_VALUE - 1u)
        val ct = last.encrypt(empty, utf8("a"))
        val e = assertCode(ErrorCode.NOISE_FAILED) { last.encrypt(empty, utf8("b")) }
        assertTrue(e.message!!.contains("nonce exhausted"))
        val reader = CipherState(key, ULong.MAX_VALUE - 1u)
        assertArrayEquals(utf8("a"), reader.decrypt(empty, ct))
        assertCode(ErrorCode.NOISE_FAILED) { reader.decrypt(empty, ct) }
    }

    @Test
    fun doesNotAdvanceCounterOnFailedDecrypt() {
        val key = ByteArray(32) { 2 }
        val w = CipherState(key)
        val r = CipherState(key)
        val ct = w.encrypt(empty, utf8("ok"))
        val bad = ct.copyOf()
        bad[0] = (bad[0].toInt() xor 1).toByte()
        val e = assertCode(ErrorCode.NOISE_FAILED) { r.decrypt(empty, bad) }
        assertEquals("Noise: decryption failed", e.message)
        assertArrayEquals(utf8("ok"), r.decrypt(empty, ct))
    }

    @Test
    fun rejectsShortCiphertextAndBadKeyLength() {
        val cs = CipherState(ByteArray(32))
        assertCode(ErrorCode.NOISE_FAILED) { cs.decrypt(empty, ByteArray(15)) }
        assertCode(ErrorCode.NOISE_FAILED) { CipherState(ByteArray(16)) }
    }
}
