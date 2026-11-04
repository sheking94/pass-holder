// Noise_KK_25519_AESGCM_SHA256, Noise Protocol Framework revision 34 (2018-07-11):
// https://noiseprotocol.org/noise.html
// Sections 5.1 (CipherState), 5.2 (SymmetricState), 5.3 (HandshakeState), 7.5 (KK),
// 12.1 (25519), 12.3 (AESGCM), 12.5 (SHA256).
// Test vector: Cacophony, see core/test-vectors/noise-kk.json.
//
//   KK:
//     -> s
//     <- s
//     ...
//     -> e, es, ss
//     <- e, ee, se
package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import org.bouncycastle.math.ec.rfc7748.X25519
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Prologue bound into every PassHolder device-to-device handshake. */
val P2P_PROLOGUE: ByteArray = Encoding.utf8("passholder/v2/noise")

private val PROTOCOL_NAME = Encoding.utf8("Noise_KK_25519_AESGCM_SHA256")
private const val DHLEN = 32
private const val HASHLEN = 32
private const val TAGLEN = 16

/** Noise messages, handshake and transport, are at most 65535 bytes (section 3). */
private const val MAX_MESSAGE = 65535
private val EMPTY = ByteArray(0)

class KeyPair(val publicKey: ByteArray, val privateKey: ByteArray)

object NoiseKeys {
    private val random = SecureRandom()

    /** Fresh X25519 key pair from the CSPRNG. */
    fun generate(): KeyPair {
        val sk = ByteArray(DHLEN)
        X25519.generatePrivateKey(random, sk)
        return fromPrivateKey(sk)
    }

    /** X25519 key pair for an existing 32-byte private key (stored keys, test vectors). */
    fun fromPrivateKey(privateKey: ByteArray): KeyPair {
        require(privateKey.size == DHLEN) { "Noise: private key must be 32 bytes" }
        val pk = ByteArray(DHLEN)
        X25519.scalarMultBase(privateKey, 0, pk, 0)
        return KeyPair(pk, privateKey.copyOf())
    }
}

private fun dh(keyPair: KeyPair, publicKey: ByteArray): ByteArray {
    val out = ByteArray(DHLEN)
    // false means an all-zero result, i.e. a low-order peer key.
    require(X25519.calculateAgreement(keyPair.privateKey, 0, publicKey, 0, out, 0)) { "Noise: invalid public key" }
    return out
}

private fun hash(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
}

/** HKDF(chaining_key, input_key_material, 2) from section 4.3. */
private fun hkdf2(chainingKey: ByteArray, ikm: ByteArray): Pair<ByteArray, ByteArray> {
    val tempKey = hmac(chainingKey, ikm)
    val out1 = hmac(tempKey, byteArrayOf(0x01))
    val out2 = hmac(tempKey, out1 + byteArrayOf(0x02))
    return out1 to out2
}

/** AESGCM nonce: 32 bits of zeros followed by the 64-bit big-endian counter (section 12.3). */
private fun aesGcmNonce(n: ULong): ByteArray {
    val nonce = ByteArray(12)
    for (i in 0 until 8) nonce[11 - i] = (n shr (8 * i)).toByte()
    return nonce
}

/**
 * Noise CipherState: key k (or none) and 64-bit counter n.
 * Without a key, encrypt/decrypt return the input unchanged (section 5.1).
 */
class CipherState(key: ByteArray?, n: ULong = 0uL) {
    private val key: SecretKeySpec?
    private var n: ULong = n

    init {
        require(key == null || key.size == 32) { "Noise: cipher key must be 32 bytes" }
        this.key = key?.let { SecretKeySpec(it, "AES") }
    }

    fun hasKey(): Boolean = key != null

    @Synchronized
    fun encrypt(ad: ByteArray, plaintext: ByteArray): ByteArray {
        if (key == null) return plaintext.copyOf()
        require(plaintext.size + TAGLEN <= MAX_MESSAGE) { "Noise: message exceeds 65535 bytes" }
        return run(Cipher.ENCRYPT_MODE, ad, plaintext)
    }

    @Synchronized
    fun decrypt(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        if (key == null) return ciphertext.copyOf()
        require(ciphertext.size <= MAX_MESSAGE) { "Noise: message exceeds 65535 bytes" }
        require(ciphertext.size >= TAGLEN) { "Noise: ciphertext too short" }
        return run(Cipher.DECRYPT_MODE, ad, ciphertext)
    }

    /** One AEAD operation with the current nonce on a fresh Cipher; n advances only on success. */
    private fun run(mode: Int, ad: ByteArray, input: ByteArray): ByteArray {
        check(n != ULong.MAX_VALUE) { "Noise: nonce exhausted" }
        val out = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(mode, key, GCMParameterSpec(TAGLEN * 8, aesGcmNonce(n)))
            cipher.updateAAD(ad)
            cipher.doFinal(input)
        } catch (e: GeneralSecurityException) {
            if (mode == Cipher.DECRYPT_MODE) throw IllegalArgumentException("Noise: decryption failed", e)
            throw e
        }
        n++
        return out
    }
}

/** Noise SymmetricState (section 5.2). */
private class SymmetricState(protocolName: ByteArray) {
    var ck: ByteArray
    var h: ByteArray
    var cipher = CipherState(null)

    init {
        h = if (protocolName.size <= HASHLEN) protocolName.copyOf(HASHLEN) else hash(protocolName)
        ck = h.copyOf()
    }

    fun mixKey(ikm: ByteArray) {
        val (newCk, tempK) = hkdf2(ck, ikm)
        ck = newCk
        cipher = CipherState(tempK.copyOf(32))
    }

    fun mixHash(data: ByteArray) {
        h = hash(h + data)
    }

    fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val ct = cipher.encrypt(h, plaintext)
        mixHash(ct)
        return ct
    }

    fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val pt = cipher.decrypt(h, ciphertext)
        mixHash(ciphertext)
        return pt
    }

    fun split(): Pair<CipherState, CipherState> {
        val (k1, k2) = hkdf2(ck, EMPTY)
        return CipherState(k1.copyOf(32)) to CipherState(k2.copyOf(32))
    }
}

data class TransportCiphers(val send: CipherState, val recv: CipherState)

private enum class Step { WRITE1, READ1, WRITE2, READ2, DONE, SPLIT, FAILED }

/**
 * Noise_KK_25519_AESGCM_SHA256 handshake (section 5.3 HandshakeState with pattern KK).
 * Message 1 goes initiator -> responder, message 2 responder -> initiator; then split().
 * Any error leaves the handshake unusable.
 */
class NoiseKK private constructor(
    private val initiator: Boolean,
    private val s: KeyPair,
    rs: ByteArray,
    prologue: ByteArray,
    private var e: KeyPair?,
) {
    private val rs: ByteArray = rs.copyOf()
    private var re: ByteArray? = null
    private val ss = SymmetricState(PROTOCOL_NAME)
    private var step: Step = if (initiator) Step.WRITE1 else Step.READ1

    init {
        require(s.privateKey.size == DHLEN && s.publicKey.size == DHLEN) {
            "Noise: static key pair must be 32-byte X25519 keys"
        }
        require(rs.size == DHLEN) { "Noise: remote static key must be 32 bytes" }
        ss.mixHash(prologue)
        // Pre-messages: "-> s" then "<- s", hashed in pattern order on both sides.
        ss.mixHash(if (initiator) s.publicKey else this.rs)
        ss.mixHash(if (initiator) this.rs else s.publicKey)
    }

    companion object {
        fun initiator(s: KeyPair, rs: ByteArray, prologue: ByteArray, e: KeyPair? = null): NoiseKK =
            NoiseKK(true, s, rs, prologue, e)

        fun responder(s: KeyPair, rs: ByteArray, prologue: ByteArray, e: KeyPair? = null): NoiseKK =
            NoiseKK(false, s, rs, prologue, e)
    }

    @Synchronized
    fun writeMessage(payload: ByteArray): ByteArray {
        val expected = if (initiator) Step.WRITE1 else Step.WRITE2
        require(DHLEN + payload.size + TAGLEN <= MAX_MESSAGE) { "Noise: message exceeds 65535 bytes" }
        return guard(expected) {
            // Token "e".
            val eph = e ?: NoiseKeys.generate()
            e = eph
            ss.mixHash(eph.publicKey)
            if (initiator) {
                // -> e, es, ss
                ss.mixKey(dh(eph, rs)) // es: DH(e, rs)
                ss.mixKey(dh(s, rs)) // ss
            } else {
                // <- e, ee, se
                ss.mixKey(dh(eph, re!!)) // ee
                ss.mixKey(dh(eph, rs)) // se: responder computes DH(e, rs)
            }
            eph.publicKey + ss.encryptAndHash(payload)
        }
    }

    @Synchronized
    fun readMessage(message: ByteArray): ByteArray {
        val expected = if (initiator) Step.READ2 else Step.READ1
        require(message.size <= MAX_MESSAGE) { "Noise: message exceeds 65535 bytes" }
        require(message.size >= DHLEN + TAGLEN) { "Noise: handshake message too short" }
        return guard(expected) {
            // Token "e".
            val remoteE = message.copyOfRange(0, DHLEN)
            re = remoteE
            ss.mixHash(remoteE)
            if (initiator) {
                // <- e, ee, se
                ss.mixKey(dh(e!!, remoteE)) // ee
                ss.mixKey(dh(s, remoteE)) // se: initiator computes DH(s, re)
            } else {
                // -> e, es, ss
                ss.mixKey(dh(s, remoteE)) // es: responder computes DH(s, re)
                ss.mixKey(dh(s, rs)) // ss
            }
            ss.decryptAndHash(message.copyOfRange(DHLEN, message.size))
        }
    }

    /** Transport ciphers after both handshake messages; callable once. */
    @Synchronized
    fun split(): TransportCiphers {
        check(step == Step.DONE) { "Noise: split() before the handshake finished" }
        val (c1, c2) = ss.split()
        step = Step.SPLIT
        // c1 encrypts initiator -> responder, c2 responder -> initiator.
        return if (initiator) TransportCiphers(c1, c2) else TransportCiphers(c2, c1)
    }

    /** Final handshake hash h, for channel binding; available once the handshake has finished. */
    val handshakeHash: ByteArray
        @Synchronized get() {
            check(step == Step.DONE || step == Step.SPLIT) { "Noise: handshake not finished" }
            return ss.h.copyOf()
        }

    /** Runs one handshake step; input-size errors above leave the state intact, any later error fails it. */
    private fun guard(expected: Step, op: () -> ByteArray): ByteArray {
        check(step == expected) { "Noise: unexpected handshake step (state ${step.name.lowercase()})" }
        try {
            val out = op()
            step = when (expected) {
                Step.WRITE1 -> Step.READ2
                Step.READ1 -> Step.WRITE2
                else -> Step.DONE
            }
            return out
        } catch (t: Throwable) {
            step = Step.FAILED
            throw t
        }
    }
}
