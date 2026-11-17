package io.github.sheking94.passholder.core.p2p

/** Passes [e] to [onError]; a failing [onError] must not change the answer. */
internal fun reportError(onError: (Throwable) -> Unit, e: Throwable) {
    try {
        onError(e)
    } catch (_: Exception) {
    }
}
