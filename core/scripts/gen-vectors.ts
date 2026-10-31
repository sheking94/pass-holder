// Generates test-vectors/v1.json. Every client (TypeScript, Kotlin) must reproduce these values exactly.
// Run: npm run gen-vectors -w core
import { writeFileSync } from "node:fs";
import { authHash, deriveMasterKey, splitMasterKey, type KdfParams } from "../src/kdf.ts";
import { seal } from "../src/cipher.ts";
import { entryAad, VAULT_KEY_AAD } from "../src/vault.ts";
import { fromHex, toBase64, toHex, utf8 } from "../src/encoding.ts";

async function kdfVector(description: string, password: string, saltHex: string, cost: Omit<KdfParams, "alg" | "salt">) {
  const params: KdfParams = { alg: "argon2id", salt: toBase64(fromHex(saltHex)), ...cost };
  const masterKey = await deriveMasterKey(password, params);
  const { encKey, authKey } = splitMasterKey(masterKey);
  return {
    description,
    password,
    passwordUtf8Nfc: toHex(utf8(password)),
    kdf: params,
    masterKey: toHex(masterKey),
    encKey: toHex(encKey),
    authKey: toHex(authKey),
    authHash: toHex(authHash(authKey)),
  };
}

async function sealVector(description: string, keyHex: string, plaintext: Uint8Array, aad: string, nonceHex: string) {
  return {
    description,
    key: keyHex,
    plaintextHex: toHex(plaintext),
    aad,
    nonce: nonceHex,
    blob: await seal(fromHex(keyHex), plaintext, aad, fromHex(nonceHex)),
  };
}

const kdf = [
  await kdfVector(
    "Default parameters, non-ASCII password",
    "correct horse battery staple 🐴",
    "000102030405060708090a0b0c0d0e0f",
    { memoryKiB: 65536, iterations: 3, parallelism: 4 },
  ),
  await kdfVector(
    "Minimum parameters; password given in NFD, must be normalized to NFC (same key as \"Zażółć\")",
    "Zażółć",
    "f0e1d2c3b4a5968778695a4b3c2d1e0f",
    { memoryKiB: 19456, iterations: 2, parallelism: 1 },
  ),
];

const encKey = kdf[0]!.encKey;
const vaultKey = "5f9d1c3a7b2e4d6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
const entryId = "3f2a8c1e-6b4d-4e9a-9c7f-1a2b3c4d5e6f";

const liveJson = JSON.stringify({ name: "example.com", username: "jan@example.com", password: "p@ss wörd!", modifiedAt: 1793404800000 });
const tombstoneJson = JSON.stringify({ modifiedAt: 1793404900000 });

const seals = [
  await sealVector("Wrapped vault key", encKey, fromHex(vaultKey), VAULT_KEY_AAD, "aabbccddeeff001122334455"),
  await sealVector(`Live entry ${entryId}: ${liveJson}`, vaultKey, utf8(liveJson), entryAad(entryId), "0102030405060708090a0b0c"),
  await sealVector(`Tombstone ${entryId}: ${tombstoneJson}`, vaultKey, utf8(tombstoneJson), entryAad(entryId), "0c0b0a090807060504030201"),
];

const out = { format: "passholder-test-vectors", version: 1, kdf, seal: seals };
writeFileSync(new URL("../test-vectors/v1.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("Wrote test-vectors/v1.json");
