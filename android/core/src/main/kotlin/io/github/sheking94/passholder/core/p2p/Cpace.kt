// CPace PAKE, cipher suite CPACE-RISTR255-SHA512, initiator-responder setting.
// Implements draft-irtf-cfrg-cpace-21 (23 April 2026):
// https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt
// Sections 6.3 (lv_cat, transcript_ir), 7.2 (protocol), 8.1 (generator_string)
// and 8.3 (G_Ristretto255); test vectors from Appendix B.3.
package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import java.math.BigInteger
import java.security.MessageDigest

enum class CpaceRole(val wire: String) { INITIATOR("initiator"), RESPONDER("responder") }

/** Opaque per-run secret state: own scalar, own element, associated data and session id. */
class CpaceState internal constructor(
    internal val y: BigInteger,
    internal val ownY: ByteArray,
    internal val ad: ByteArray,
    internal val sid: ByteArray,
)

/** `message` is lv_cat(Y, ad) and is sent to the peer. */
data class CpaceStart(val state: CpaceState, val message: ByteArray)

object Cpace {
    /** Channel identifier for pairing a device with the phone. */
    val PAIRING_CI: ByteArray = Encoding.utf8("passholder/v2/pair")

    private val DSI = Encoding.utf8("CPaceRistretto255")
    private val DSI_ISK = Encoding.utf8("CPaceRistretto255_ISK")

    /** SHA-512 input block size (H.s_in_bytes). */
    private const val S_IN_BYTES = 128
    private const val FIELD_SIZE_BYTES = 32
    private const val INVALID = "CPace: invalid peer element"

    private fun sha512(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(data)

    private fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var pos = 0
        for (p in parts) {
            p.copyInto(out, pos)
            pos += p.size
        }
        return out
    }

    /** prepend_len (draft A.1.1): LEB128 length followed by the data. */
    private fun prependLen(data: ByteArray): ByteArray {
        val len = ArrayList<Byte>()
        var n = data.size
        do {
            val low = n and 0x7f
            n = n ushr 7
            len.add((if (n > 0) low or 0x80 else low).toByte())
        } while (n > 0)
        return concat(len.toByteArray(), data)
    }

    /** lv_cat (draft A.1.3): concatenation of prepend_len of every argument. */
    fun lvCat(vararg parts: ByteArray): ByteArray = concat(*Array(parts.size) { prependLen(parts[it]) })

    /** Inverse of lvCat for exactly [count] fields; null on any framing error (including trailing bytes). */
    private fun lvSplit(bytes: ByteArray, count: Int): List<ByteArray>? {
        val out = ArrayList<ByteArray>()
        var pos = 0
        repeat(count) {
            var len = 0L
            var shift = 1L
            while (true) {
                if (pos >= bytes.size || shift > (1L shl 28)) return null
                val b = bytes[pos++].toInt() and 0xff
                len += (b and 0x7f) * shift
                shift *= 128
                if (b and 0x80 == 0) break
            }
            if (len > bytes.size - pos) return null
            out.add(bytes.copyOfRange(pos, pos + len.toInt()))
            pos += len.toInt()
        }
        return if (pos == bytes.size) out else null
    }

    /** generator_string (draft A.2). */
    internal fun generatorString(prs: ByteArray, ci: ByteArray, sid: ByteArray): ByteArray {
        val zpad = maxOf(0, S_IN_BYTES - 1 - prependLen(prs).size - prependLen(DSI).size)
        return lvCat(DSI, prs, ByteArray(zpad), ci, sid)
    }

    /** Hash of generator_string truncated to 2 * field size (draft 8.3); the input of the element derivation. */
    internal fun generatorHash(prs: ByteArray, ci: ByteArray, sid: ByteArray): ByteArray =
        sha512(generatorString(prs, ci, sid)).copyOf(2 * FIELD_SIZE_BYTES)

    /** G_Ristretto255.calculate_generator (draft 8.3). */
    internal fun calculateGenerator(prs: ByteArray, ci: ByteArray, sid: ByteArray): ByteArray =
        generator(prs, ci, sid).encode()

    private fun generator(prs: ByteArray, ci: ByteArray, sid: ByteArray): RistrettoPoint =
        RistrettoPoint.fromUniformBytes(generatorHash(prs, ci, sid))

    private fun bytesToScalarLE(bytes: ByteArray): BigInteger =
        BigInteger(1, bytes.reversedArray()).mod(RistrettoPoint.L)

    /** G.sample_scalar (draft 8.3): 32 random bytes, bits above 252 cleared, little-endian. */
    private fun sampleScalar(): BigInteger {
        while (true) {
            val bytes = Encoding.randomBytes(32)
            bytes[31] = (bytes[31].toInt() and 0x0f).toByte()
            val y = bytesToScalarLE(bytes)
            if (y.signum() != 0) return y
        }
    }

    /** scalar_mult_vfy (draft 8.3): decode failure or a neutral result means abort (K == G.I). */
    private fun scalarMultVfy(y: BigInteger, peerBytes: ByteArray): ByteArray {
        val peer = try {
            RistrettoPoint.decode(peerBytes)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException(INVALID)
        }
        require(!peer.isIdentity()) { INVALID }
        val k = peer.multiply(y)
        require(!k.isIdentity()) { INVALID }
        return k.encode()
    }

    /** K = scalar_mult_vfy(y, Y_peer), with y as 32 little-endian bytes. */
    internal fun sharedPoint(y: ByteArray, peer: ByteArray): ByteArray = scalarMultVfy(bytesToScalarLE(y), peer)

    /**
     * Starts a CPace run. `message` is lv_cat(Y, ad) and is sent to the peer.
     * [ya] (32 bytes, little-endian) is only for reproducing test vectors.
     */
    fun start(prs: ByteArray, ci: ByteArray, sid: ByteArray, ad: ByteArray, ya: ByteArray? = null): CpaceStart {
        val y = if (ya == null) {
            sampleScalar()
        } else {
            require(ya.size == 32) { "CPace: scalar must be 32 bytes" }
            bytesToScalarLE(ya).also { require(it.signum() != 0) { "CPace: zero scalar" } }
        }
        val ownY = generator(prs, ci, sid).multiply(y).encode()
        return CpaceStart(CpaceState(y, ownY, ad.copyOf(), sid.copyOf()), lvCat(ownY, ad))
    }

    /** Finishes a CPace run and returns ISK (64 bytes); throws [IllegalArgumentException] on an invalid peer message. */
    fun finish(state: CpaceState, peerMessage: ByteArray, role: CpaceRole): ByteArray {
        val fields = lvSplit(peerMessage, 2) ?: throw IllegalArgumentException(INVALID)
        val (peerY, peerAd) = fields
        require(peerY.size == FIELD_SIZE_BYTES) { INVALID }

        val k = scalarMultVfy(state.y, peerY)

        val own = lvCat(state.ownY, state.ad)
        val peer = lvCat(peerY, peerAd)
        val transcript = if (role == CpaceRole.INITIATOR) concat(own, peer) else concat(peer, own)
        return sha512(concat(lvCat(DSI_ISK, state.sid, k), transcript))
    }
}
