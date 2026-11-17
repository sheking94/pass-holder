import { open, seal } from "./cipher.ts";
import { randomBytes } from "./encoding.ts";
import { KEY_BYTES } from "./sizes.ts";

export const VAULT_KEY_AAD = "passholder/v1/vault-key";

export function newVaultKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

export function wrapVaultKey(
  encKey: Uint8Array,
  vaultKey: Uint8Array,
  nonce?: Uint8Array,
): Promise<string> {
  return seal(encKey, vaultKey, VAULT_KEY_AAD, nonce);
}

/** Throws if the master password is wrong (the GCM tag does not verify). */
export async function unwrapVaultKey(encKey: Uint8Array, wrapped: string): Promise<Uint8Array> {
  const key = await open(encKey, wrapped, VAULT_KEY_AAD);
  if (key.length !== KEY_BYTES) throw new Error("Vault key must be 32 bytes");
  return key;
}
