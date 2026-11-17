import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { open, seal } from "../cipher.ts";
import { fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from "../encoding.ts";
import { assertKdfParamsAcceptable, type KdfParams } from "../kdf.ts";
import { isRecord } from "../strict-json.ts";

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  /** Base64, 32-byte X25519 public key. */
  staticPublicKey: string;
}

export interface VaultInfo {
  /** Base64, 16 bytes. */
  epoch: string;
  kdf: KdfParams;
  wrappedVaultKey: string;
  addresses: string[];
}

export type PairingKind = "identity" | "vault-info";
/** CPace role of the side that seals a pairing message: the extension is the initiator, the phone the responder. */
export type PairingRole = "initiator" | "responder";

export const MAX_DEVICE_NAME_LENGTH = 64;
export const MAX_ADDRESSES = 16;
export const MAX_ADDRESS_LENGTH = 256;

const PAIR_KEY_INFO = utf8("passholder/v2/pair-key");

/** 8 decimal digits. Bytes >= 250 are rejected so every digit is equally likely (no `% 10` bias). */
export function generatePairingCode(): string {
  let code = "";
  while (code.length < 8) {
    for (const b of randomBytes(16)) {
      if (b < 250 && code.length < 8) code += String(b % 10);
    }
  }
  return code;
}

export function pairingKey(isk: Uint8Array): Uint8Array {
  return hkdf(sha256, isk, undefined, PAIR_KEY_INFO, 32);
}

/** AAD binds the message to its kind and to the sender's role, so a reflected message does not open. */
export function pairingAad(kind: PairingKind, from: PairingRole): string {
  return `passholder/v2/pair/${kind}/${from}`;
}

export async function sealPairingMessage(
  key: Uint8Array,
  kind: PairingKind,
  /** Role of the side calling this (the sealer). */
  from: PairingRole,
  value: DeviceIdentity | VaultInfo,
  /** Only for test vectors; normal callers leave it out and get a random nonce. */
  nonce?: Uint8Array,
): Promise<string> {
  return seal(key, utf8(JSON.stringify(value)), pairingAad(kind, from), nonce);
}

/** Strict Base64: must decode and re-encode to the same text, with an exact decoded length when given. */
function checkBase64(value: unknown, field: string, length?: number): Uint8Array {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
  } catch {
    throw new Error(`${field} is not valid Base64`);
  }
  if (toBase64(bytes) !== value) throw new Error(`${field} is not canonical Base64`);
  if (length !== undefined && bytes.length !== length)
    throw new Error(`${field} must be ${length} bytes`);
  if (bytes.length === 0) throw new Error(`${field} must not be empty`);
  return bytes;
}

function parseIdentity(v: unknown): DeviceIdentity {
  if (!isRecord(v)) throw new Error("Identity must be an object");
  const { deviceId, name, staticPublicKey } = v;
  if (typeof deviceId !== "string" || deviceId.length < 1 || deviceId.length > 64)
    throw new Error("Invalid deviceId");
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_DEVICE_NAME_LENGTH)
    throw new Error("Invalid name");
  checkBase64(staticPublicKey, "staticPublicKey", 32);
  return { deviceId, name, staticPublicKey: staticPublicKey as string };
}

function parseVaultInfo(v: unknown): VaultInfo {
  if (!isRecord(v)) throw new Error("Vault info must be an object");
  const { epoch, kdf, wrappedVaultKey, addresses } = v;
  checkBase64(epoch, "epoch", 16);
  if (!isRecord(kdf)) throw new Error("Invalid kdf");
  checkBase64(kdf.salt, "kdf.salt", 16);
  assertKdfParamsAcceptable(kdf as unknown as KdfParams);
  checkBase64(wrappedVaultKey, "wrappedVaultKey");
  if (
    !Array.isArray(addresses) ||
    addresses.length > MAX_ADDRESSES ||
    !addresses.every(
      (a) => typeof a === "string" && a.length >= 1 && a.length <= MAX_ADDRESS_LENGTH,
    )
  ) {
    throw new Error(
      `addresses must be at most ${MAX_ADDRESSES} strings of 1..${MAX_ADDRESS_LENGTH} chars`,
    );
  }
  return {
    epoch: epoch as string,
    kdf: kdf as unknown as KdfParams,
    wrappedVaultKey: wrappedVaultKey as string,
    addresses: addresses as string[],
  };
}

export async function openPairingMessage(
  key: Uint8Array,
  kind: PairingKind,
  /** Role of the side that sealed the message (the peer of the caller). */
  from: PairingRole,
  blob: string,
): Promise<DeviceIdentity | VaultInfo> {
  const parsed: unknown = JSON.parse(fromUtf8(await open(key, blob, pairingAad(kind, from))));
  return kind === "identity" ? parseIdentity(parsed) : parseVaultInfo(parsed);
}
