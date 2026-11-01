import { deriveMasterKey, fromBase64, fromUtf8, newKdfParams, open, seal, toBase64, utf8, type KdfParams } from "@passholder/core";

/**
 * Unlocking with a PIN. The PIN never replaces the master password: it only re-wraps the keys this
 * browser already has after a normal unlock, so the vault can be opened again without typing the
 * master password. The server knows nothing about the PIN.
 *
 * A 4-6 digit PIN has at most a million values. Argon2id makes each guess slow, but someone who has a
 * copy of the PinLock can try them all offline (minutes for 4 digits, hours for 6). The attempt limit
 * only stops someone who guesses through the popup. See docs/WTYCZKA_PIN.md.
 */

export const PIN_PATTERN = /^\d{4,6}$/;

/** After this many wrong PINs in a row the PIN is deleted and only the master password works. */
export const MAX_PIN_ATTEMPTS = 5;

const PIN_LOCK_AAD = "passholder/v1/pin-lock";

/** Kept in chrome.storage (session by default, local if the user asks for the PIN to survive a restart). */
export interface PinLock {
  /** Own Argon2id salt and parameters, unrelated to the master password ones. */
  kdf: KdfParams;
  /** AES-256-GCM of JSON {vaultKey, authKey} under the key derived from the PIN. */
  wrappedKeys: string;
  /** Wrong PINs since the last successful unlock (by PIN or by master password). */
  failedAttempts: number;
}

/** The two keys the extension needs while unlocked: one decrypts the vault, the other logs in to the server. */
export interface UnlockKeys {
  vaultKey: Uint8Array;
  authKey: Uint8Array;
}

export class WrongPinError extends Error {}

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export async function createPinLock(pin: string, keys: UnlockKeys): Promise<PinLock> {
  if (!isValidPin(pin)) throw new Error("PIN musi mieć od 4 do 6 cyfr");
  const kdf = newKdfParams();
  const pinKey = await deriveMasterKey(pin, kdf);
  const plaintext = utf8(JSON.stringify({ vaultKey: toBase64(keys.vaultKey), authKey: toBase64(keys.authKey) }));
  return { kdf, wrappedKeys: await seal(pinKey, plaintext, PIN_LOCK_AAD), failedAttempts: 0 };
}

/** Throws WrongPinError if the PIN is wrong (the GCM tag does not verify). */
export async function openPinLock(pin: string, lock: PinLock): Promise<UnlockKeys> {
  if (!isValidPin(pin)) throw new WrongPinError("PIN musi mieć od 4 do 6 cyfr");
  const pinKey = await deriveMasterKey(pin, lock.kdf);
  let plaintext: Uint8Array;
  try {
    plaintext = await open(pinKey, lock.wrappedKeys, PIN_LOCK_AAD);
  } catch {
    throw new WrongPinError("Zły PIN");
  }
  const parsed = JSON.parse(fromUtf8(plaintext)) as { vaultKey: string; authKey: string };
  return { vaultKey: fromBase64(parsed.vaultKey), authKey: fromBase64(parsed.authKey) };
}
