package io.github.sheking94.passholder.core.p2p

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.math.sign

@Serializable
private data class HlcCompareVector(val description: String, val a: Hlc, val b: Hlc, val expected: Int)

/** Sections of v2.json grow with each module; unknown sections are ignored until their task adds them. */
@Serializable
private data class P2pVectors(val hlcCompare: List<HlcCompareVector>)

/** The same core/test-vectors/v2.json the TypeScript core is tested against. */
class P2pVectorsTest {
    private val vectors: P2pVectors = Json { ignoreUnknownKeys = true }.decodeFromString(
        File(System.getProperty("passholder.repoRoot"), "core/test-vectors/v2.json").readText(),
    )

    @TestFactory
    fun hlcCompare() = vectors.hlcCompare.map { v ->
        DynamicTest.dynamicTest("HLC: ${v.description.take(60)}") {
            assertEquals(v.expected, v.a.compareTo(v.b).sign)
        }
    }
}
