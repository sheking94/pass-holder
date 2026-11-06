package io.github.sheking94.passholder.core.p2p

import java.math.BigInteger

/**
 * Element of the ristretto255 group (RFC 9496), held in extended Edwards coordinates mod p = 2^255 - 19.
 *
 * NOT constant time: plain BigInteger arithmetic and data-dependent branches leak timing.
 * Acceptable here only because it runs on the phone for short PAKE exchanges; do not reuse for long-term keys.
 */
internal class RistrettoPoint private constructor(
    val X: BigInteger,
    val Y: BigInteger,
    val Z: BigInteger,
    val T: BigInteger,
) {
    /** RFC 9496 §4.3.2: canonical 32-byte little-endian encoding. */
    fun encode(): ByteArray {
        val u1 = (Z + Y) * (Z - Y) % P
        val u2 = X * Y % P
        val invsqrt = sqrtRatioM1(ONE, u1 * u2 % P * u2).second
        val den1 = invsqrt * u1 % P
        val den2 = invsqrt * u2 % P
        val zInv = den1 * den2 % P * T % P
        val rotate = isNegative(T * zInv)
        val x = if (rotate) Y * SQRT_M1 % P else X
        var y = if (rotate) X * SQRT_M1 % P else Y
        val denInv = if (rotate) den1 * INVSQRT_A_MINUS_D % P else den2
        if (isNegative(x * zInv)) y = y.negate()
        return toBytes(abs(denInv * (Z - y)))
    }

    /** add-2008-hwcd-3 for a = -1. */
    operator fun plus(o: RistrettoPoint): RistrettoPoint {
        val a = (Y - X) * (o.Y - o.X) % P
        val b = (Y + X) * (o.Y + o.X) % P
        val c = T * K % P * o.T % P
        val d = Z * TWO % P * o.Z % P
        val e = b - a
        val f = d - c
        val g = d + c
        val h = b + a
        return RistrettoPoint(mod(e * f), mod(g * h), mod(f * g), mod(e * h))
    }

    /** Double-and-add over the bits of a non-negative [scalar] (not reduced mod [L]). */
    fun multiply(scalar: BigInteger): RistrettoPoint {
        require(scalar.signum() >= 0) { "ristretto255: negative scalar" }
        var acc = IDENTITY
        for (i in scalar.bitLength() - 1 downTo 0) {
            acc += acc
            if (scalar.testBit(i)) acc += this
        }
        return acc
    }

    fun isIdentity(): Boolean = this == IDENTITY

    /** RFC 9496 §4.3.3. */
    override fun equals(other: Any?): Boolean {
        if (other !is RistrettoPoint) return false
        return mod(X * other.Y - Y * other.X).signum() == 0 || mod(Y * other.Y - X * other.X).signum() == 0
    }

    override fun hashCode(): Int = encode().contentHashCode()

    companion object {
        val P: BigInteger = BigInteger.TWO.pow(255) - BigInteger.valueOf(19)
        val L: BigInteger = BigInteger.TWO.pow(252) + BigInteger("27742317777372353535851937790883648493")

        // RFC 9496 §4.1.
        val D = BigInteger("37095705934669439343138083508754565189542113879843219016388785533085940283555")
        val SQRT_M1 = BigInteger("19681161376707505956807079304988542015446066515923890162744021073123829784752")
        private val SQRT_AD_MINUS_ONE =
            BigInteger("25063068953384623474111414158702152701244531502492656460079210482610430750235")
        private val INVSQRT_A_MINUS_D =
            BigInteger("54469307008909316920995813868745141605393597292927456921205312896311721017578")
        private val ONE_MINUS_D_SQ =
            BigInteger("1159843021668779879193775521855586647937357759715417654439879720876111806838")
        private val D_MINUS_ONE_SQ =
            BigInteger("40440834346308536858101042469323190826248399146238708352240133220865137265952")

        private val ONE = BigInteger.ONE
        private val TWO = BigInteger.TWO
        private val K = D * TWO % P
        private val P_MINUS_5_DIV_8 = (P - BigInteger.valueOf(5)) / BigInteger.valueOf(8)

        val IDENTITY = RistrettoPoint(BigInteger.ZERO, ONE, ONE, BigInteger.ZERO)

        /** Ed25519 base point: y = 4/5, x the non-negative root of x^2 = (y^2 - 1) / (d*y^2 + 1). */
        val GENERATOR: RistrettoPoint = run {
            val y = BigInteger.valueOf(4) * BigInteger.valueOf(5).modInverse(P) % P
            val yy = y * y % P
            val x = sqrtRatioM1(yy - ONE, D * yy + ONE).second
            RistrettoPoint(x, y, ONE, x * y % P)
        }

        /** RFC 9496 §4.3.1; throws [IllegalArgumentException] for any non-canonical or invalid encoding. */
        fun decode(bytes: ByteArray): RistrettoPoint {
            require(bytes.size == 32) { "ristretto255: encoding must be 32 bytes" }
            val s = fromBytes(bytes)
            require(s < P) { "ristretto255: non-canonical encoding" }
            require(!isNegative(s)) { "ristretto255: negative encoding" }
            val ss = s * s % P
            val u1 = mod(ONE - ss)
            val u2 = (ONE + ss) % P
            val u2Sqr = u2 * u2 % P
            val v = mod(-(D * u1 % P * u1) - u2Sqr)
            val (wasSquare, invsqrt) = sqrtRatioM1(ONE, v * u2Sqr)
            val denX = invsqrt * u2 % P
            val denY = invsqrt * denX % P * v % P
            val x = abs(TWO * s * denX)
            val y = u1 * denY % P
            val t = x * y % P
            require(wasSquare && !isNegative(t) && y.signum() != 0) { "ristretto255: invalid encoding" }
            return RistrettoPoint(x, y, ONE, t)
        }

        /** RFC 9496 §4.3.4 element derivation from 64 uniform bytes. */
        fun fromUniformBytes(bytes: ByteArray): RistrettoPoint {
            require(bytes.size == 64) { "ristretto255: uniform input must be 64 bytes" }
            return map(bytes.copyOfRange(0, 32)) + map(bytes.copyOfRange(32, 64))
        }

        private fun map(bytes: ByteArray): RistrettoPoint {
            val t = fromBytes(bytes).clearBit(255) % P
            val r = SQRT_M1 * t % P * t % P
            val u = (r + ONE) * ONE_MINUS_D_SQ % P
            val v = mod((-ONE - r * D) * (r + D))
            val (wasSquare, s0) = sqrtRatioM1(u, v)
            val s = if (wasSquare) s0 else mod(-abs(s0 * t))
            val c = if (wasSquare) P - ONE else r
            val n = mod(c * (r - ONE) % P * D_MINUS_ONE_SQ - v)
            val w0 = TWO * s % P * v % P
            val w1 = n * SQRT_AD_MINUS_ONE % P
            val ss = s * s % P
            val w2 = mod(ONE - ss)
            val w3 = (ONE + ss) % P
            return RistrettoPoint(w0 * w3 % P, w2 * w1 % P, w1 * w3 % P, w0 * w2 % P)
        }

        /** RFC 9496 §4.2: (was_square, non-negative root of u/v or of SQRT_M1*u/v). */
        private fun sqrtRatioM1(u0: BigInteger, v0: BigInteger): Pair<Boolean, BigInteger> {
            val u = mod(u0)
            val v = mod(v0)
            val v3 = v * v % P * v % P
            val v7 = v3 * v3 % P * v % P
            var r = u * v3 % P * (u * v7 % P).modPow(P_MINUS_5_DIV_8, P) % P
            val check = v * r % P * r % P
            val correctSign = check == u
            val flippedSign = check == mod(-u)
            val flippedSignI = check == mod(-u * SQRT_M1)
            if (flippedSign || flippedSignI) r = r * SQRT_M1 % P
            return Pair(correctSign || flippedSign, abs(r))
        }

        private fun mod(a: BigInteger): BigInteger = a.mod(P)

        private fun isNegative(a: BigInteger): Boolean = mod(a).testBit(0)

        private fun abs(a: BigInteger): BigInteger = mod(a).let { if (it.testBit(0)) P - it else it }

        private fun fromBytes(bytes: ByteArray): BigInteger = BigInteger(1, bytes.reversedArray())

        private fun toBytes(a: BigInteger): ByteArray {
            val be = mod(a).toByteArray()
            val out = ByteArray(32)
            for (i in 0 until minOf(be.size, 32)) out[i] = be[be.size - 1 - i]
            return out
        }
    }
}
