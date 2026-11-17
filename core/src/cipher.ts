import { concat, fromBase64, randomBytes, toBase64, utf8 } from "./encoding.ts";
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, KEY_BYTES } from "./sizes.ts";

const FORMAT_VERSION = 0x01;
/** Bytes `seal` adds to the plaintext: version (1) + nonce (12) + tag (16) = 29. */
export const SEAL_OVERHEAD_BYTES = 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES;

async function importKey(rawKey: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (rawKey.length !== KEY_BYTES) throw new Error("Key must be 32 bytes");
  return crypto.subtle.importKey("raw", rawKey as BufferSource, "AES-GCM", false, [usage]);
}

/**
 * AES-256-GCM with a random nonce.
 * Output is Base64 of: version (1 byte) || nonce (12 bytes) || ciphertext || tag (16 bytes).
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Promise<string> {
  return sealWithNonce(key, plaintext, aad, randomBytes(GCM_NONCE_BYTES));
}

/**
 * `seal` with a caller-given nonce. Production code passes a fresh random one (as `seal` and `encryptFile` do);
 * a fixed nonce is only for test vectors: reusing a nonce with the same key breaks AES-GCM.
 */
export async function sealWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
  nonce: Uint8Array,
): Promise<string> {
  if (nonce.length !== GCM_NONCE_BYTES) throw new Error("Nonce must be 12 bytes");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: utf8(aad) as BufferSource },
    await importKey(key, "encrypt"),
    plaintext as BufferSource,
  );
  return toBase64(concat(Uint8Array.of(FORMAT_VERSION), nonce, new Uint8Array(ciphertext)));
}

export async function open(key: Uint8Array, blob: string, aad: string): Promise<Uint8Array> {
  const bytes = fromBase64(blob);
  if (bytes.length < SEAL_OVERHEAD_BYTES) throw new Error("Blob too short");
  if (bytes[0] !== FORMAT_VERSION) throw new Error(`Unsupported blob version: ${bytes[0]}`);
  const nonce = bytes.subarray(1, 1 + GCM_NONCE_BYTES);
  const ciphertext = bytes.subarray(1 + GCM_NONCE_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: utf8(aad) as BufferSource },
    await importKey(key, "decrypt"),
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}
