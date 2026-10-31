import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authHash, deriveMasterKey, splitMasterKey, type KdfParams } from "../src/kdf.ts";
import { open, seal } from "../src/cipher.ts";
import { fromHex, toHex, utf8 } from "../src/encoding.ts";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/v1.json", import.meta.url), "utf8")) as {
  kdf: { description: string; password: string; passwordUtf8Nfc: string; kdf: KdfParams; masterKey: string; encKey: string; authKey: string; authHash: string }[];
  seal: { description: string; key: string; plaintextHex: string; aad: string; nonce: string; blob: string }[];
};

describe("test vectors v1", () => {
  for (const v of vectors.kdf) {
    it(`KDF: ${v.description}`, async () => {
      expect(toHex(utf8(v.password))).toBe(v.passwordUtf8Nfc);
      const masterKey = await deriveMasterKey(v.password, v.kdf);
      const { encKey, authKey } = splitMasterKey(masterKey);
      expect(toHex(masterKey)).toBe(v.masterKey);
      expect(toHex(encKey)).toBe(v.encKey);
      expect(toHex(authKey)).toBe(v.authKey);
      expect(toHex(authHash(authKey))).toBe(v.authHash);
    }, 30_000);
  }

  for (const v of vectors.seal) {
    it(`AES-GCM: ${v.description.slice(0, 40)}`, async () => {
      const key = fromHex(v.key);
      expect(await seal(key, fromHex(v.plaintextHex), v.aad, fromHex(v.nonce))).toBe(v.blob);
      expect(toHex(await open(key, v.blob, v.aad))).toBe(v.plaintextHex);
    });
  }
});
