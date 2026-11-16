package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Aead
import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.Encoding.utf8
import io.github.sheking94.passholder.core.KdfParams
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import javax.crypto.AEADBadTagException

class PairingTest {
    private val key = ByteArray(32) { it.toByte() }
    private val base64Of16 = "AAECAwQFBgcICQoLDA0ODw=="
    private val base64Of32 = Encoding.toBase64(ByteArray(32) { it.toByte() })

    private val identity = DeviceIdentity("ext-1", "Chrome", base64Of32)
    private val kdf = KdfParams("argon2id", base64Of16, 65536, 3, 4)
    private val vaultInfo = VaultInfo(base64Of16, kdf, Encoding.toBase64(ByteArray(40) { 1 }), listOf("192.168.1.5:8443"))

    private fun rejectsIdentity(value: DeviceIdentity) {
        val blob = Pairing.sealIdentity(key, CpaceRole.RESPONDER, value)
        assertThrows<IllegalArgumentException> { Pairing.openIdentity(key, CpaceRole.RESPONDER, blob) }
    }

    private fun rejectsVaultInfo(value: VaultInfo) {
        val blob = Pairing.sealVaultInfo(key, CpaceRole.RESPONDER, value)
        assertThrows<IllegalArgumentException> { Pairing.openVaultInfo(key, CpaceRole.RESPONDER, blob) }
    }

    @Test
    fun `valid messages round trip with random nonces`() {
        val a = Pairing.sealIdentity(key, CpaceRole.INITIATOR, identity)
        assertEquals(identity, Pairing.openIdentity(key, CpaceRole.INITIATOR, a))
        val v = Pairing.sealVaultInfo(key, CpaceRole.RESPONDER, vaultInfo)
        assertEquals(vaultInfo, Pairing.openVaultInfo(key, CpaceRole.RESPONDER, v))
    }

    @Test
    fun `a message opened with the sender role reversed does not open`() {
        val blob = Pairing.sealIdentity(key, CpaceRole.RESPONDER, identity)
        assertThrows<AEADBadTagException> { Pairing.openIdentity(key, CpaceRole.INITIATOR, blob) }
    }

    @Test
    fun `a wrong key does not open`() {
        val blob = Pairing.sealIdentity(key, CpaceRole.RESPONDER, identity)
        assertThrows<AEADBadTagException> { Pairing.openIdentity(ByteArray(32), CpaceRole.RESPONDER, blob) }
    }

    @Test
    fun `a message of the other kind does not open`() {
        val blob = Pairing.sealIdentity(key, CpaceRole.RESPONDER, identity)
        assertThrows<AEADBadTagException> { Pairing.openVaultInfo(key, CpaceRole.RESPONDER, blob) }
    }

    @Test
    fun `identity with a 31 byte public key is rejected`() {
        rejectsIdentity(identity.copy(staticPublicKey = Encoding.toBase64(ByteArray(31))))
    }

    @Test
    fun `identity with bad name or device id is rejected`() {
        rejectsIdentity(identity.copy(name = "n".repeat(65)))
        rejectsIdentity(identity.copy(name = ""))
        rejectsIdentity(identity.copy(deviceId = "d".repeat(65)))
        rejectsIdentity(identity.copy(deviceId = ""))
    }

    @Test
    fun `non canonical epoch is rejected`() {
        // Decodes to the same 16 bytes as base64Of16, but the last data character carries non-zero unused bits.
        val nonCanonical = "AAECAwQFBgcICQoLDA0ODx=="
        assertTrue(Encoding.fromBase64(nonCanonical).contentEquals(Encoding.fromBase64(base64Of16)))
        rejectsVaultInfo(vaultInfo.copy(epoch = nonCanonical))
    }

    @Test
    fun `vault info with 17 addresses is rejected but 16 are accepted`() {
        rejectsVaultInfo(vaultInfo.copy(addresses = List(17) { "10.0.0.$it:1" }))
        val sixteen = vaultInfo.copy(addresses = List(16) { "10.0.0.$it:1" })
        val blob = Pairing.sealVaultInfo(key, CpaceRole.RESPONDER, sixteen)
        assertEquals(sixteen, Pairing.openVaultInfo(key, CpaceRole.RESPONDER, blob))
    }

    @Test
    fun `vault info with an empty or oversized address is rejected`() {
        rejectsVaultInfo(vaultInfo.copy(addresses = listOf("")))
        rejectsVaultInfo(vaultInfo.copy(addresses = listOf("a".repeat(257))))
    }

    @Test
    fun `vault info with weak kdf iterations is rejected`() {
        rejectsVaultInfo(vaultInfo.copy(kdf = kdf.copy(iterations = 1)))
    }

    @Test
    fun `vault info with a short salt or empty wrapped key is rejected`() {
        rejectsVaultInfo(vaultInfo.copy(kdf = kdf.copy(salt = Encoding.toBase64(ByteArray(15)))))
        rejectsVaultInfo(vaultInfo.copy(wrappedVaultKey = ""))
    }

    @Test
    fun `wrongly typed JSON is rejected`() {
        val aad = Pairing.aad(PairingKind.IDENTITY, CpaceRole.RESPONDER)
        for (json in listOf("[]", "null", "\"x\"", """{"deviceId":1,"name":"a","staticPublicKey":"$base64Of32"}""")) {
            val blob = Aead.seal(key, utf8(json), aad)
            assertThrows<IllegalArgumentException> { Pairing.openIdentity(key, CpaceRole.RESPONDER, blob) }
        }
    }

    @Test
    fun `generateCode gives 8 digits`() {
        repeat(1000) { assertTrue(Regex("^[0-9]{8}$").matches(Pairing.generateCode())) }
    }

    private fun session(codeExt: String, codePhone: String): Pair<ByteArray, ByteArray> {
        val sid = Encoding.randomBytes(16)
        val ext = Cpace.start(utf8(codeExt), Cpace.PAIRING_CI, sid, ByteArray(0))
        val phone = Cpace.start(utf8(codePhone), Cpace.PAIRING_CI, sid, ByteArray(0))
        val iskExt = Cpace.finish(ext.state, phone.message, CpaceRole.INITIATOR)
        val iskPhone = Cpace.finish(phone.state, ext.message, CpaceRole.RESPONDER)
        return Pairing.key(iskExt) to Pairing.key(iskPhone)
    }

    @Test
    fun `full in-memory pairing with the same code`() {
        val code = Pairing.generateCode()
        val (extKey, phoneKey) = session(code, code)
        assertTrue(extKey.contentEquals(phoneKey))

        val phoneId = DeviceIdentity("phone-1", "Pixel", base64Of32)
        val idBlob = Pairing.sealIdentity(phoneKey, CpaceRole.RESPONDER, phoneId)
        val viBlob = Pairing.sealVaultInfo(phoneKey, CpaceRole.RESPONDER, vaultInfo)
        assertEquals(phoneId, Pairing.openIdentity(extKey, CpaceRole.RESPONDER, idBlob))
        assertEquals(vaultInfo, Pairing.openVaultInfo(extKey, CpaceRole.RESPONDER, viBlob))

        val extBlob = Pairing.sealIdentity(extKey, CpaceRole.INITIATOR, identity)
        assertEquals(identity, Pairing.openIdentity(phoneKey, CpaceRole.INITIATOR, extBlob))
    }

    @Test
    fun `a different code makes the first open throw`() {
        val (extKey, phoneKey) = session("11111111", "22222222")
        val blob = Pairing.sealIdentity(phoneKey, CpaceRole.RESPONDER, identity)
        assertThrows<AEADBadTagException> { Pairing.openIdentity(extKey, CpaceRole.RESPONDER, blob) }
    }
}
