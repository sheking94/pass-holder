package io.github.sheking94.passholder.core

/** Runs [block] and checks it throws a [PassHolderException] with [code]; returns it for more checks. */
fun assertCode(code: ErrorCode, block: () -> Unit): PassHolderException {
    try {
        block()
    } catch (e: PassHolderException) {
        if (e.code == code) return e
        throw AssertionError("Expected $code, got ${e.code}", e)
    }
    throw AssertionError("Expected $code, nothing was thrown")
}
