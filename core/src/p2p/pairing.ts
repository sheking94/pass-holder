import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { open, seal } from "../cipher.ts";
import { fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from "../encoding.ts";
import { assertKdfParamsAcceptable, type KdfParams } from "../kdf.ts";

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

function aad(kind: PairingKind): string {
  return `passholder/v2/pair/${kind}`;
}

export async function sealPairingMessage(
  key: Uint8Array,
  kind: PairingKind,
  value: DeviceIdentity | VaultInfo,
  /** Only for test vectors; normal callers leave it out and get a random nonce. */
  nonce?: Uint8Array,
): Promise<string> {
  return seal(key, utf8(JSON.stringify(value)), aad(kind), nonce);
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
  if (length !== undefined && bytes.length !== length) throw new Error(`${field} must be ${length} bytes`);
  if (bytes.length === 0) throw new Error(`${field} must not be empty`);
  return bytes;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseIdentity(v: unknown): DeviceIdentity {
  if (!isRecord(v)) throw new Error("Identity must be an object");
  const { deviceId, name, staticPublicKey } = v;
  if (typeof deviceId !== "string" || deviceId.length < 1 || deviceId.length > 64) throw new Error("Invalid deviceId");
  if (typeof name !== "string") throw new Error("Invalid name");
  checkBase64(staticPublicKey, "staticPublicKey", 32);
  return { deviceId, name, staticPublicKey: staticPublicKey as string };
}

function parseVaultInfo(v: unknown): VaultInfo {
  if (!isRecord(v)) throw new Error("Vault info must be an object");
  const { epoch, kdf, wrappedVaultKey, addresses } = v;
  checkBase64(epoch, "epoch", 16);
  if (!isRecord(kdf)) throw new Error("Invalid kdf");
  assertKdfParamsAcceptable(kdf as unknown as KdfParams);
  checkBase64(wrappedVaultKey, "wrappedVaultKey");
  if (!Array.isArray(addresses) || !addresses.every((a) => typeof a === "string")) {
    throw new Error("addresses must be a list of strings");
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
  blob: string,
): Promise<DeviceIdentity | VaultInfo> {
  const parsed: unknown = JSON.parse(fromUtf8(await open(key, blob, aad(kind))));
  return kind === "identity" ? parseIdentity(parsed) : parseVaultInfo(parsed);
}
