package io.github.sheking94.passholder.core.p2p

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal
import java.math.BigInteger

/** The single JSON configuration of the P2P core plus helpers for numbers that arrive from the network. */
object P2pJson {
    val json: Json = Json { encodeDefaults = true }

    /** Largest integer a JS number holds exactly (Number.MAX_SAFE_INTEGER). */
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    /** The value of a JSON number that is an integer in 0..MAX_SAFE_INTEGER; null for anything else (text, fractions, negatives). */
    fun safeLong(e: JsonElement?): Long? {
        if (e !is JsonPrimitive || e.isString) return null
        val big = try {
            BigDecimal(e.content).toBigIntegerExact()
        } catch (_: ArithmeticException) {
            return null
        } catch (_: NumberFormatException) {
            return null
        }
        if (big.signum() < 0 || big > BigInteger.valueOf(MAX_SAFE_INTEGER)) return null
        return big.toLong()
    }
}
