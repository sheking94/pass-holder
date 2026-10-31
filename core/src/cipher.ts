import { concat, fromBase64, randomBytes, toBase64, utf8 } from "./encoding.ts";

const FORMAT_VERSION = 0x01;
const NONCE_LENGTH = 12;

async function importKey(rawKey: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (rawKey.length !== 32) throw new Error("Key must be 32 bytes");
  return crypto.subtle.importKey("raw", rawKey as BufferSource, "AES-GCM", false, [usage]);
}

/**
 * AES-256-GCM. Output is Base64 of: version (1 byte) || nonce (12 bytes) || ciphertext || tag (16 bytes).
 * `nonce` is only for test vectors; normal callers leave it out and get a random one.
 */
export async function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH),
): Promise<string> {
  if (nonce.length !== NONCE_LENGTH) throw new Error("Nonce must be 12 bytes");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: utf8(aad) as BufferSource },
    await importKey(key, "encrypt"),
    plaintext as BufferSource,
  );
  return toBase64(concat(Uint8Array.of(FORMAT_VERSION), nonce, new Uint8Array(ciphertext)));
}

export async function open(key: Uint8Array, blob: string, aad: string): Promise<Uint8Array> {
  const bytes = fromBase64(blob);
  if (bytes.length < 1 + NONCE_LENGTH + 16) throw new Error("Blob too short");
  if (bytes[0] !== FORMAT_VERSION) throw new Error(`Unsupported blob version: ${bytes[0]}`);
  const nonce = bytes.subarray(1, 1 + NONCE_LENGTH);
  const ciphertext = bytes.subarray(1 + NONCE_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: utf8(aad) as BufferSource },
    await importKey(key, "decrypt"),
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}
