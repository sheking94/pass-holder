package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.KdfParams
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class HostStateTest {
    @TempDir
    lateinit var dir: File

    private val kdf = KdfParams("argon2id", Encoding.toBase64(ByteArray(16) { 1 }), 65536, 3, 1)

    private object XorWrapper : SecretWrapper {
        override fun wrap(secret: ByteArray): String = Encoding.toBase64(ByteArray(secret.size) { (secret[it].toInt() xor 0x5A).toByte() })
        override fun unwrap(wrapped: String): ByteArray = Encoding.fromBase64(wrapped).let { b -> ByteArray(b.size) { (b[it].toInt() xor 0x5A).toByte() } }
    }

    private fun store(wrapper: SecretWrapper = PlainSecretWrapper) = HostStateStore(File(dir, "host.json"), wrapper)

    @Test
    fun saveLoadRoundTrip() {
        val s = store()
        val state = s.newState(kdf, "wrapped").copy(
            keyCheck = "kc",
            devices = listOf(StoredDevice("d1", "Laptop", "AAEC", 10L, 20L), StoredDevice("d2", "Other", "AwQF", 11L)),
        )
        s.save(state)
        assertEquals(state, s.load())
    }

    @Test
    fun staticKeyIsStableAcrossReload() {
        val s = store()
        val state = s.newState(null, null)
        s.save(state)
        val loaded = s.load()!!
        assertArrayEquals(s.staticKey(state).publicKey, s.staticKey(loaded).publicKey)
        assertArrayEquals(s.staticKey(state).privateKey, s.staticKey(loaded).privateKey)
        assertNull(loaded.kdf)
    }

    @Test
    fun newStatesDiffer() {
        val s = store()
        val a = s.newState(kdf, null)
        val b = s.newState(kdf, null)
        assertNotEquals(a.epoch, b.epoch)
        assertNotEquals(a.deviceId, b.deviceId)
        assertEquals(16, Encoding.fromBase64(a.epoch).size)
    }

    @Test
    fun missingFileLoadsNull() {
        assertNull(store().load())
    }

    @Test
    fun foreignJsonIsRejected() {
        File(dir, "host.json").writeText("""{"hello":"world"}""")
        assertThrows(IllegalStateException::class.java) { store().load() }
        File(dir, "host.json").writeText("not json")
        assertThrows(IllegalStateException::class.java) { store().load() }
    }

    @Test
    fun wrapperIsUsedForStaticKey() {
        val s = store(XorWrapper)
        val state = s.newState(null, null)
        val priv = s.staticKey(state).privateKey
        assertNotEquals(Encoding.toBase64(priv), state.wrappedStaticKey)
        assertFalse(File(dir, "host.json").exists())
        s.save(state)
        assertFalse(File(dir, "host.json").readText().contains(Encoding.toBase64(priv)))
        assertArrayEquals(priv, store(XorWrapper).staticKey(store(XorWrapper).load()!!).privateKey)
    }

    @Test
    fun deleteRemovesFileAndToPairedDeviceDecodesKey() {
        val s = store()
        s.save(s.newState(null, null))
        s.delete()
        assertNull(s.load())
        assertTrue(!File(dir, "host.json.tmp").exists())
        val p = StoredDevice("d1", "Laptop", Encoding.toBase64(byteArrayOf(1, 2, 3)), 5L).toPairedDevice()
        assertEquals("d1", p.deviceId)
        assertEquals("Laptop", p.name)
        assertArrayEquals(byteArrayOf(1, 2, 3), p.staticPublicKey)
    }
}
