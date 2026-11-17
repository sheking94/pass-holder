import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { open, seal } from "../cipher.ts";
import { fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from "../encoding.ts";
import { assertKdfParamsAcceptable, type KdfParams } from "../kdf.ts";
import { isRecord } from "../strict-json.ts";
import { KEY_BYTES, RANDOM_ID_BYTES, SALT_BYTES } from "../sizes.ts";
import { MAX_DEVICE_ID_LENGTH } from "./hlc.ts";

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
export const PAIRING_CODE_LENGTH = 8;
/** How long the phone accepts a pairing code (PAIRING_CODE_TTL_MS in the Kotlin PairingHost). */
export const PAIRING_CODE_TTL_MS = 2 * 60_000;

const PAIR_KEY_INFO = utf8("passholder/v2/pair-key");

/** PAIRING_CODE_LENGTH decimal digits. Bytes >= 250 are rejected so every digit is equally likely (no `% 10` bias). */
export function generatePairingCode(): string {
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < 250 && code.length < PAIRING_CODE_LENGTH) code += String(b % 10);
    }
  }
  return code;
}

export function pairingKey(isk: Uint8Array): Uint8Array {
  return hkdf(sha256, isk, undefined, PAIR_KEY_INFO, KEY_BYTES);
}

/** AAD binds the message to its kind and to the sender's role, so a reflected message does not open. */
export function pairingAad(kind: PairingKind, from: PairingRole): string {
  return `passholder/v2/pair/${kind}/${from}`;
}

/** Seals this device's identity; `from` is the role of the caller (the sealer). */
export function sealIdentity(
  key: Uint8Array,
  from: PairingRole,
  identity: DeviceIdentity,
): Promise<string> {
  return sealPairingJson(key, "identity", from, identity);
}

/** Seals the vault info; `from` is the role of the caller (the sealer). */
export function sealVaultInfo(
  key: Uint8Array,
  from: PairingRole,
  info: VaultInfo,
): Promise<string> {
  return sealPairingJson(key, "vault-info", from, info);
}

function sealPairingJson(
  key: Uint8Array,
  kind: PairingKind,
  from: PairingRole,
  value: DeviceIdentity | VaultInfo,
): Promise<string> {
  return seal(key, utf8(JSON.stringify(value)), pairingAad(kind, from));
}

/**
 * Strict Base64: must decode and re-encode to the same text, with an exact decoded length when given.
 * Returns the checked text.
 */
function checkBase64(value: unknown, field: string, length?: number): string {
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
  return value;
}

function parseIdentity(v: unknown): DeviceIdentity {
  if (!isRecord(v)) throw new Error("Identity must be an object");
  const { deviceId, name, staticPublicKey } = v;
  if (typeof deviceId !== "string" || deviceId.length < 1 || deviceId.length > MAX_DEVICE_ID_LENGTH)
    throw new Error("Invalid deviceId");
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_DEVICE_NAME_LENGTH)
    throw new Error("Invalid name");
  return {
    deviceId,
    name,
    staticPublicKey: checkBase64(staticPublicKey, "staticPublicKey", KEY_BYTES),
  };
}

function parseVaultInfo(v: unknown): VaultInfo {
  if (!isRecord(v)) throw new Error("Vault info must be an object");
  const { kdf, addresses } = v;
  const epoch = checkBase64(v.epoch, "epoch", RANDOM_ID_BYTES);
  if (!isRecord(kdf)) throw new Error("Invalid kdf");
  checkBase64(kdf.salt, "kdf.salt", SALT_BYTES);
  assertKdfParamsAcceptable(kdf as unknown as KdfParams);
  const wrappedVaultKey = checkBase64(v.wrappedVaultKey, "wrappedVaultKey");
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
  return { epoch, kdf: kdf as unknown as KdfParams, wrappedVaultKey, addresses };
}

/** Opens and checks a peer's identity; `from` is the role of the side that sealed it (the caller's peer). */
export async function openIdentity(
  key: Uint8Array,
  from: PairingRole,
  blob: string,
): Promise<DeviceIdentity> {
  return parseIdentity(await openPairingJson(key, "identity", from, blob));
}

/** Opens and checks vault info; `from` is the role of the side that sealed it (the caller's peer). */
export async function openVaultInfo(
  key: Uint8Array,
  from: PairingRole,
  blob: string,
): Promise<VaultInfo> {
  return parseVaultInfo(await openPairingJson(key, "vault-info", from, blob));
}

async function openPairingJson(
  key: Uint8Array,
  kind: PairingKind,
  from: PairingRole,
  blob: string,
): Promise<unknown> {
  return JSON.parse(fromUtf8(await open(key, blob, pairingAad(kind, from))));
}
