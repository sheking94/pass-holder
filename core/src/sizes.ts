/** Byte units and crypto lengths shared by the core, so sizes are not written as bare literals. */

export const KIB = 1024;
export const MIB = 1024 * KIB;

/** AES-256 key, X25519 key, HKDF output and Argon2id output: 32 bytes. */
export const KEY_BYTES = 32;
/** Argon2id salt. */
export const SALT_BYTES = 16;
/** AES-GCM nonce. */
export const GCM_NONCE_BYTES = 12;
/** AES-GCM authentication tag. */
export const GCM_TAG_BYTES = 16;
/** Random identifiers such as the vault epoch and the session id. */
export const RANDOM_ID_BYTES = 16;
