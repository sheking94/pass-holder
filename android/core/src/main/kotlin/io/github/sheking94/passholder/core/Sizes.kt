package io.github.sheking94.passholder.core

// Byte units and crypto lengths shared by the core, same as core/src/sizes.ts.

const val KIB = 1024
const val MIB = 1024 * KIB

/** AES-256 key, X25519 key, HKDF output and Argon2id output: 32 bytes. */
const val KEY_BYTES = 32

/** Argon2id salt. */
const val SALT_BYTES = 16

/** AES-GCM nonce. */
const val GCM_NONCE_BYTES = 12

/** AES-GCM authentication tag. */
const val GCM_TAG_BYTES = 16

/** Random identifiers such as the vault epoch and the session id. */
const val RANDOM_ID_BYTES = 16
