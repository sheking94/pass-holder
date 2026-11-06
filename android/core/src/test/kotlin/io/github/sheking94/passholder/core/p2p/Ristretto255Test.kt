package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.assertThrows
import java.io.File
import java.math.BigInteger

@Serializable
private data class OneWayMapVector(val input: String, val output: String)

@Serializable
private data class RistrettoVectors(
    val source: String,
    val multiples: List<String>,
    val invalid: List<String>,
    val oneWayMap: List<OneWayMapVector>,
)

/** RFC 9496 Appendix A vectors from core/test-vectors/ristretto255-rfc9496.json. */
class Ristretto255Test {
    private val vectors: RistrettoVectors = Json.decodeFromString(
        File(System.getProperty("passholder.repoRoot"), "core/test-vectors/ristretto255-rfc9496.json").readText(),
    )

    private fun hex(p: RistrettoPoint) = Encoding.toHex(p.encode())

    @TestFactory
    fun multiplesOfGenerator() = vectors.multiples.mapIndexed { i, expected ->
        DynamicTest.dynamicTest("B·$i") {
            assertEquals(expected, hex(RistrettoPoint.GENERATOR.multiply(BigInteger.valueOf(i.toLong()))))
            assertEquals(expected, hex(RistrettoPoint.decode(Encoding.fromHex(expected))))
        }
    }

    @Test
    fun repeatedAdditionMatchesMultiples() {
        var acc = RistrettoPoint.IDENTITY
        for (expected in vectors.multiples) {
            assertEquals(expected, hex(acc))
            acc += RistrettoPoint.GENERATOR
        }
    }

    @TestFactory
    fun invalidEncodingsAreRejected() = vectors.invalid.map { h ->
        DynamicTest.dynamicTest("invalid $h") {
            assertThrows<IllegalArgumentException> { RistrettoPoint.decode(Encoding.fromHex(h)) }
        }
    }

    @TestFactory
    fun oneWayMap() = vectors.oneWayMap.map { v ->
        DynamicTest.dynamicTest("map ${v.input.take(16)}") {
            assertEquals(v.output, hex(RistrettoPoint.fromUniformBytes(Encoding.fromHex(v.input))))
        }
    }

    @Test
    fun generatorHasOrderL() {
        assertEquals(BigInteger.TWO.pow(252) + BigInteger("27742317777372353535851937790883648493"), RistrettoPoint.L)
        assertTrue(RistrettoPoint.GENERATOR.multiply(RistrettoPoint.L).isIdentity())
        assertFalse(RistrettoPoint.GENERATOR.multiply(RistrettoPoint.L - BigInteger.ONE).isIdentity())
        assertTrue(RistrettoPoint.IDENTITY.isIdentity())
        assertFalse(RistrettoPoint.GENERATOR.isIdentity())
    }

    @Test
    fun equalityIgnoresRepresentation() {
        val p = RistrettoPoint.GENERATOR.multiply(BigInteger.valueOf(7))
        val q = RistrettoPoint.decode(p.encode())
        assertEquals(p, q)
        assertEquals(p.hashCode(), q.hashCode())
        assertFalse(p == RistrettoPoint.GENERATOR)
    }

    @Test
    fun wrongLengthsAreRejected() {
        assertThrows<IllegalArgumentException> { RistrettoPoint.decode(ByteArray(31)) }
        assertThrows<IllegalArgumentException> { RistrettoPoint.decode(ByteArray(33)) }
        assertThrows<IllegalArgumentException> { RistrettoPoint.fromUniformBytes(ByteArray(63)) }
        assertThrows<IllegalArgumentException> { RistrettoPoint.fromUniformBytes(ByteArray(65)) }
        assertThrows<IllegalArgumentException> { RistrettoPoint.GENERATOR.multiply(BigInteger.valueOf(-1)) }
    }

    @Test
    fun constantsSatisfyTheirDefinitions() {
        val p = RistrettoPoint.P
        assertEquals(BigInteger.TWO.pow(255) - BigInteger.valueOf(19), p)
        assertEquals(p - BigInteger.ONE, RistrettoPoint.SQRT_M1.modPow(BigInteger.TWO, p))
        assertEquals(
            BigInteger.valueOf(-121665).mod(p),
            (RistrettoPoint.D * BigInteger.valueOf(121666)).mod(p),
        )
    }
}
