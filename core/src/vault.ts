import { open, seal } from "./cipher.ts";
import { fromUtf8, randomBytes, utf8 } from "./encoding.ts";

export const VAULT_KEY_AAD = "passholder/v1/vault-key";

export function entryAad(id: string): string {
  return `passholder/v1/entry/${id}`;
}

/** Decrypted content of a live entry. */
export interface EntryData {
  name: string;
  username: string;
  password: string;
  /** Milliseconds since the Unix epoch, set by the device that made the change. Decides sync conflicts. */
  modifiedAt: number;
}

/** Decrypted content of a deleted entry (tombstone). Kept so deletions sync and win or lose by time like edits. */
export interface TombstoneData {
  modifiedAt: number;
}

export function newVaultKey(): Uint8Array {
  return randomBytes(32);
}

export function wrapVaultKey(encKey: Uint8Array, vaultKey: Uint8Array, nonce?: Uint8Array): Promise<string> {
  return seal(encKey, vaultKey, VAULT_KEY_AAD, nonce);
}

/** Throws if the master password is wrong (the GCM tag does not verify). */
export async function unwrapVaultKey(encKey: Uint8Array, wrapped: string): Promise<Uint8Array> {
  const key = await open(encKey, wrapped, VAULT_KEY_AAD);
  if (key.length !== 32) throw new Error("Vault key must be 32 bytes");
  return key;
}

export function encryptPayload(
  vaultKey: Uint8Array,
  id: string,
  data: EntryData | TombstoneData,
  nonce?: Uint8Array,
): Promise<string> {
  return seal(vaultKey, utf8(JSON.stringify(data)), entryAad(id), nonce);
}

export async function decryptPayload(vaultKey: Uint8Array, id: string, blob: string): Promise<unknown> {
  return JSON.parse(fromUtf8(await open(vaultKey, blob, entryAad(id))));
}

export function parseEntryData(value: unknown): EntryData {
  const v = value as Record<string, unknown>;
  if (
    typeof v !== "object" || v === null ||
    typeof v.name !== "string" || typeof v.username !== "string" ||
    typeof v.password !== "string" || !Number.isSafeInteger(v.modifiedAt)
  ) {
    throw new Error("Invalid entry payload");
  }
  return { name: v.name, username: v.username, password: v.password, modifiedAt: v.modifiedAt as number };
}

/**
 * A tombstone holds nothing but modifiedAt. Checked strictly because the deleted flag next to the blob
 * is not encrypted: without this a server could mark a live entry as deleted and every client would
 * accept its payload (it has modifiedAt too) as a tombstone. Entry and tombstone payloads never look
 * alike, so the encrypted content itself says which one it is (S2 of the security review).
 */
export function parseTombstoneData(value: unknown): TombstoneData {
  const v = value as Record<string, unknown>;
  if (
    typeof v !== "object" || v === null || Array.isArray(v) ||
    Object.keys(v).some((key) => key !== "modifiedAt") || !Number.isSafeInteger(v.modifiedAt)
  ) {
    throw new Error("Invalid tombstone payload");
  }
  return { modifiedAt: v.modifiedAt as number };
}
