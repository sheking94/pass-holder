package io.github.sheking94.passholder.app.autofill

/**
 * The login of a save request that arrived while the vault was locked, kept in memory only until the user
 * unlocks (2 minutes at most). Never written to disk, never put into an Intent. One candidate: a newer one
 * replaces the older.
 */
class PendingSave(private val now: () -> Long) {
    private var data: SaveData? = null
    private var since = 0L

    @Synchronized
    fun put(data: SaveData) {
        this.data = data
        since = now()
    }

    /** Returns the candidate and forgets it; null when none or older than [TTL_MS]. */
    @Synchronized
    fun take(): SaveData? {
        val current = fresh()
        data = null
        return current
    }

    /** Whether a fresh candidate is waiting; takes nothing. */
    @Synchronized
    fun peek(): Boolean = fresh() != null

    @Synchronized
    fun clear() {
        data = null
    }

    private fun fresh(): SaveData? = data?.takeIf { now() - since <= TTL_MS }

    companion object {
        const val TTL_MS = 120_000L
    }
}
