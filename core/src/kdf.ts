import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, randomBytes, toBase64, utf8 } from "./encoding.ts";
import { KEY_BYTES, SALT_BYTES } from "./sizes.ts";

/** Argon2id parameters. Stored in plain text next to the vault so another device can derive the same keys. */
export interface KdfParams {
  alg: "argon2id";
  /** Base64, 16 bytes. */
  salt: string;
  /** Memory in KiB. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF = { memoryKiB: 65536, iterations: 3, parallelism: 4 } as const;

/** Lower bounds a device accepts from another one, so a malicious peer cannot downgrade the KDF. */
export const MIN_KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

/** Upper bounds, so a malicious peer cannot make the device allocate gigabytes or hash for minutes. */
export const MAX_KDF = { memoryKiB: 1024 * 1024, iterations: 100, parallelism: 64 } as const;

function inRange(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

export function newKdfParams(): KdfParams {
  return { alg: "argon2id", salt: toBase64(randomBytes(SALT_BYTES)), ...DEFAULT_KDF };
}

export function assertKdfParamsAcceptable(params: KdfParams): void {
  if (params.alg !== "argon2id") throw new Error(`Unsupported KDF: ${params.alg}`);
  if (fromBase64(params.salt).length !== SALT_BYTES) throw new Error("KDF salt must be 16 bytes");
  // Checked as integers in range, not just "not below the minimum": NaN or a string compares false with
  // everything and would otherwise slip through.
  if (!inRange(params.memoryKiB, MIN_KDF.memoryKiB, MAX_KDF.memoryKiB))
    throw new Error("KDF memory out of range");
  if (!inRange(params.iterations, MIN_KDF.iterations, MAX_KDF.iterations))
    throw new Error("KDF iterations out of range");
  if (!inRange(params.parallelism, MIN_KDF.parallelism, MAX_KDF.parallelism))
    throw new Error("KDF parallelism out of range");
}

export interface DerivedKeys {
  /** Wraps and unwraps the vault key. Never leaves the device. */
  encKey: Uint8Array;
}

const INFO_ENC = utf8("passholder/v1/enc");

export async function deriveMasterKey(
  masterPassword: string,
  params: KdfParams,
): Promise<Uint8Array> {
  return argon2idAsync(utf8(masterPassword), fromBase64(params.salt), {
    m: params.memoryKiB,
    t: params.iterations,
    p: params.parallelism,
    dkLen: KEY_BYTES,
  });
}

export function splitMasterKey(masterKey: Uint8Array): DerivedKeys {
  return {
    encKey: hkdf(sha256, masterKey, undefined, INFO_ENC, KEY_BYTES),
  };
}

export async function deriveKeys(masterPassword: string, params: KdfParams): Promise<DerivedKeys> {
  return splitMasterKey(await deriveMasterKey(masterPassword, params));
}
