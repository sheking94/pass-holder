import { describe, expect, it } from "vitest";
import { open, seal } from "../src/cipher.ts";
import {
  concat,
  fromBase64,
  fromHex,
  fromUtf8,
  randomBytes,
  toBase64,
  toHex,
  utf8,
} from "../src/encoding.ts";
import {
  CHARACTER_GROUPS,
  generatePassword,
  MAX_LENGTH,
  MIN_LENGTH,
  randomIndex,
} from "../src/generator.ts";
import {
  assertKdfParamsAcceptable,
  deriveKeys,
  MAX_KDF,
  MIN_KDF,
  newKdfParams,
  type KdfParams,
} from "../src/kdf.ts";
import { unwrapVaultKey, wrapVaultKey, newVaultKey } from "../src/vault.ts";

describe("encoding", () => {
  it("normalizes passwords to NFC, so 'ą' typed two ways gives the same bytes", () => {
    const composed = "ą"; // ą
    const decomposed = "ą"; // a + ogonek
    expect(toHex(utf8(decomposed))).toBe(toHex(utf8(composed)));
  });

  it("round-trips Base64 and hex for every byte value", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
    expect(fromHex(toHex(all))).toEqual(all);
    expect(toBase64(new Uint8Array())).toBe("");
  });

  it("rejects malformed hex, Base64 and UTF-8", () => {
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
    expect(() => fromBase64("not base64!")).toThrow();
    expect(() => fromUtf8(Uint8Array.of(0xff, 0xfe))).toThrow();
  });

  it("concatenates in order", () => {
    expect(concat(Uint8Array.of(1), new Uint8Array(), Uint8Array.of(2, 3))).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });
});

describe("cipher edge cases", () => {
  const key = randomBytes(32);

  it("rejects keys and nonces of the wrong size", async () => {
    await expect(seal(randomBytes(16), utf8("x"), "aad")).rejects.toThrow("32 bytes");
    await expect(seal(key, utf8("x"), "aad", randomBytes(8))).rejects.toThrow("12 bytes");
  });

  it("rejects a truncated blob and an unknown format version", async () => {
    const blob = fromBase64(await seal(key, utf8("secret"), "aad"));
    await expect(open(key, toBase64(blob.subarray(0, 28)), "aad")).rejects.toThrow("too short");
    const v2 = Uint8Array.from(blob);
    v2[0] = 2;
    await expect(open(key, toBase64(v2), "aad")).rejects.toThrow("version");
  });

  it("detects a change in the nonce", async () => {
    const blob = fromBase64(await seal(key, utf8("secret"), "aad"));
    blob[1]! ^= 1;
    await expect(open(key, toBase64(blob), "aad")).rejects.toThrow();
  });

  it("encrypts an empty plaintext", async () => {
    const blob = await seal(key, new Uint8Array(), "aad");
    expect(fromBase64(blob)).toHaveLength(1 + 12 + 16);
    expect(await open(key, blob, "aad")).toEqual(new Uint8Array());
  });
});

describe("master password", () => {
  const params: KdfParams = {
    alg: "argon2id",
    salt: toBase64(new Uint8Array(16).fill(1)),
    ...MIN_KDF,
  };

  it("a wrong password cannot unwrap the vault key", async () => {
    const vaultKey = newVaultKey();
    const right = await deriveKeys("correct", params);
    const wrong = await deriveKeys("Correct", params);
    const wrapped = await wrapVaultKey(right.encKey, vaultKey);
    await expect(unwrapVaultKey(wrong.encKey, wrapped)).rejects.toThrow();
    expect(await unwrapVaultKey(right.encKey, wrapped)).toEqual(vaultKey);
  });

  it("a different salt gives different keys for the same password", async () => {
    const a = await deriveKeys("same", params);
    const b = await deriveKeys("same", { ...params, salt: toBase64(new Uint8Array(16).fill(2)) });
    expect(toHex(a.encKey)).not.toBe(toHex(b.encKey));
  });

  it("refuses to unwrap something that is not a 32-byte key", async () => {
    const encKey = randomBytes(32);
    const wrapped = await wrapVaultKey(encKey, randomBytes(16));
    await expect(unwrapVaultKey(encKey, wrapped)).rejects.toThrow("32 bytes");
  });
});

describe("KDF parameters from another device", () => {
  const ok = newKdfParams();
  const bad: [string, Partial<KdfParams> | Record<string, unknown>][] = [
    ["another algorithm", { alg: "pbkdf2" }],
    ["a short salt", { salt: toBase64(randomBytes(8)) }],
    ["too little memory", { memoryKiB: MIN_KDF.memoryKiB - 1 }],
    ["too few iterations", { iterations: 1 }],
    ["no parallelism", { parallelism: 0 }],
    // A malicious peer must not be able to make the browser allocate gigabytes either.
    ["too much memory", { memoryKiB: MAX_KDF.memoryKiB + 1 }],
    ["memory that is not a number", { memoryKiB: "lots" }],
    ["NaN iterations", { iterations: Number.NaN }],
    ["fractional memory", { memoryKiB: 65536.5 }],
    ["absurd iterations", { iterations: MAX_KDF.iterations + 1 }],
  ];

  it("accepts defaults and the documented bounds", () => {
    expect(() => assertKdfParamsAcceptable(ok)).not.toThrow();
    expect(() => assertKdfParamsAcceptable({ ...ok, ...MIN_KDF })).not.toThrow();
    expect(() => assertKdfParamsAcceptable({ ...ok, memoryKiB: MAX_KDF.memoryKiB })).not.toThrow();
  });

  for (const [what, change] of bad) {
    it(`rejects ${what}`, () => {
      expect(() => assertKdfParamsAcceptable({ ...ok, ...change } as KdfParams)).toThrow();
    });
  }
});

describe("generator edge cases", () => {
  it("uses only characters from the chosen groups", () => {
    for (const group of Object.keys(CHARACTER_GROUPS) as (keyof typeof CHARACTER_GROUPS)[]) {
      const pw = generatePassword({ length: MAX_LENGTH, groups: [group] });
      expect([...pw].every((c) => CHARACTER_GROUPS[group].includes(c))).toBe(true);
    }
  });

  it("accepts the minimum and maximum length, with all four groups at the minimum", () => {
    const groups = ["lowercase", "uppercase", "digits", "symbols"] as const;
    const short = generatePassword({ length: MIN_LENGTH, groups: [...groups] });
    expect(short).toHaveLength(4);
    for (const g of groups)
      expect([...short].some((c) => CHARACTER_GROUPS[g].includes(c))).toBe(true);
    expect(generatePassword({ length: MAX_LENGTH, groups: ["digits"] })).toHaveLength(128);
  });

  it("ignores a group listed twice and rejects a non-integer length", () => {
    expect(generatePassword({ length: 10, groups: ["digits", "digits"] })).toMatch(/^\d{10}$/);
    expect(() => generatePassword({ length: 10.5, groups: ["digits"] })).toThrow();
  });

  it("does not repeat itself", () => {
    const seen = new Set(
      Array.from({ length: 1000 }, () => generatePassword({ length: 12, groups: ["lowercase"] })),
    );
    expect(seen.size).toBe(1000);
  });

  it("rejects an invalid range for randomIndex", () => {
    for (const max of [0, -1, 1.5, 2 ** 32 + 1]) expect(() => randomIndex(max)).toThrow();
    expect(randomIndex(1)).toBe(0);
  });
});
