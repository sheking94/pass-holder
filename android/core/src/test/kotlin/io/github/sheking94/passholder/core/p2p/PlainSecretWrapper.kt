package io.github.sheking94.passholder.core.p2p

import io.github.sheking94.passholder.core.Encoding

/** Test wrapper: Base64 only, no protection. */
object PlainSecretWrapper : SecretWrapper {
    override fun wrap(secret: ByteArray): String = Encoding.toBase64(secret)
    override fun unwrap(wrapped: String): ByteArray = Encoding.fromBase64(wrapped)
}
