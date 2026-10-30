import { describe, expect, it } from "vitest";
import { open, seal } from "../src/cipher.ts";
import { fromBase64, randomBytes, toBase64, utf8 } from "../src/encoding.ts";
import { decryptPayload, encryptPayload, newVaultKey, unwrapVaultKey, wrapVaultKey } from "../src/vault.ts";
import { assertKdfParamsAcceptable, newKdfParams } from "../src/kdf.ts";

describe("cipher", () => {
  it("uses a fresh nonce each time", async () => {
    const key = randomBytes(32);
    expect(await seal(key, utf8("x"), "aad")).not.toBe(await seal(key, utf8("x"), "aad"));
  });

  it("rejects a wrong key, wrong AAD and tampered data", async () => {
    const key = randomBytes(32);
    const blob = await seal(key, utf8("secret"), "aad");
    await expect(open(randomBytes(32), blob, "aad")).rejects.toThrow();
    await expect(open(key, blob, "other")).rejects.toThrow();
    const bytes = fromBase64(blob);
    bytes[bytes.length - 1]! ^= 1;
    await expect(open(key, toBase64(bytes), "aad")).rejects.toThrow();
  });

  it("binds an entry to its id, so the server cannot swap entries", async () => {
    const vaultKey = newVaultKey();
    const blob = await encryptPayload(vaultKey, "a", { modifiedAt: 1 });
    await expect(decryptPayload(vaultKey, "b", blob)).rejects.toThrow();
    expect(await decryptPayload(vaultKey, "a", blob)).toEqual({ modifiedAt: 1 });
  });

  it("wraps and unwraps the vault key", async () => {
    const encKey = randomBytes(32);
    const vaultKey = newVaultKey();
    expect(await unwrapVaultKey(encKey, await wrapVaultKey(encKey, vaultKey))).toEqual(vaultKey);
  });
});

describe("KDF parameters", () => {
  it("accepts defaults and rejects downgrades", () => {
    const params = newKdfParams();
    expect(() => assertKdfParamsAcceptable(params)).not.toThrow();
    expect(() => assertKdfParamsAcceptable({ ...params, memoryKiB: 1024 })).toThrow();
    expect(() => assertKdfParamsAcceptable({ ...params, iterations: 1 })).toThrow();
  });
});
