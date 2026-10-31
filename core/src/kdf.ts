import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, randomBytes, toBase64, utf8 } from "./encoding.ts";

/** Argon2id parameters. Stored on the server in plain text so a new device can derive the same keys. */
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

/** Lower bounds a client accepts from the server, so a malicious server cannot downgrade the KDF. */
export const MIN_KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

export function newKdfParams(): KdfParams {
  return { alg: "argon2id", salt: toBase64(randomBytes(16)), ...DEFAULT_KDF };
}

export function assertKdfParamsAcceptable(params: KdfParams): void {
  if (params.alg !== "argon2id") throw new Error(`Unsupported KDF: ${params.alg}`);
  if (fromBase64(params.salt).length !== 16) throw new Error("KDF salt must be 16 bytes");
  if (params.memoryKiB < MIN_KDF.memoryKiB) throw new Error("KDF memory too low");
  if (params.iterations < MIN_KDF.iterations) throw new Error("KDF iterations too low");
  if (params.parallelism < MIN_KDF.parallelism) throw new Error("KDF parallelism too low");
}

export interface DerivedKeys {
  /** Wraps and unwraps the vault key. Never leaves the device. */
  encKey: Uint8Array;
  /** Proves knowledge of the master password to the server. */
  authKey: Uint8Array;
}

const INFO_ENC = utf8("passholder/v1/enc");
const INFO_AUTH = utf8("passholder/v1/auth");

export async function deriveMasterKey(masterPassword: string, params: KdfParams): Promise<Uint8Array> {
  return argon2idAsync(utf8(masterPassword), fromBase64(params.salt), {
    m: params.memoryKiB,
    t: params.iterations,
    p: params.parallelism,
    dkLen: 32,
  });
}

export function splitMasterKey(masterKey: Uint8Array): DerivedKeys {
  return {
    encKey: hkdf(sha256, masterKey, undefined, INFO_ENC, 32),
    authKey: hkdf(sha256, masterKey, undefined, INFO_AUTH, 32),
  };
}

export async function deriveKeys(masterPassword: string, params: KdfParams): Promise<DerivedKeys> {
  return splitMasterKey(await deriveMasterKey(masterPassword, params));
}

/** What the server stores instead of the auth key. */
export function authHash(authKey: Uint8Array): Uint8Array {
  return sha256(authKey);
}
