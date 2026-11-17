package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.StrictJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Longest device id (UTF-16 units); the same limit in the TS core. */
const val MAX_DEVICE_ID_LENGTH = 64

/**
 * Hybrid logical clock timestamp, ordered by (ms, c, d). Short field names, because they are stored in every entry.
 *
 * @property ms wall clock in milliseconds, never lower than the last timestamp this device saw
 * @property c counter that orders events within the same ms
 * @property d device id: breaks the remaining ties, so two devices never produce equal timestamps
 */
@Serializable
data class Hlc(val ms: Long, val c: Long, val d: String) : Comparable<Hlc> {
    // String.compareTo orders by UTF-16 code units, like JS string comparison.
    override fun compareTo(other: Hlc): Int {
        if (ms != other.ms) return ms.compareTo(other.ms)
        if (c != other.c) return c.compareTo(other.c)
        return d.compareTo(other.d)
    }
}

/** Validates an HLC from the network; unknown fields are dropped. */
fun parseHlc(value: JsonElement?): Hlc {
    if (value !is JsonObject) throw IllegalArgumentException("Invalid HLC")
    val ms = P2pJson.safeLong(value["ms"])
    val c = P2pJson.safeLong(value["c"])
    val d = StrictJson.string(value["d"])
    if (ms == null || c == null || d == null || d.isEmpty() || d.length > MAX_DEVICE_ID_LENGTH) {
        throw IllegalArgumentException("Invalid HLC")
    }
    return Hlc(ms, c, d)
}

/** Clock that keeps growing even when the wall clock goes backwards. */
class HlcClock(private val deviceId: String, private val now: () -> Long = System::currentTimeMillis, last: Hlc? = null) {
    var last: Hlc? = last
        @Synchronized get
        private set

    @Synchronized
    fun tick(): Hlc {
        val prev = last
        val wall = now()
        val ms = if (prev != null) maxOf(prev.ms, wall) else wall
        val c = if (prev != null && ms == prev.ms) prev.c + 1 else 0L
        return Hlc(ms, c, deviceId).also { last = it }
    }

    /** Remembers a remote clock that runs ahead, without ticking. */
    @Synchronized
    fun observe(remote: Hlc) {
        val prev = last
        if (prev == null || remote.ms > prev.ms || (remote.ms == prev.ms && remote.c > prev.c)) {
            last = Hlc(remote.ms, remote.c, deviceId)
        }
    }
}
