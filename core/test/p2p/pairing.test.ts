import { describe, expect, it } from "vitest";
import { randomBytes, toBase64, utf8 } from "../../src/encoding.ts";
import { cpaceFinish, cpaceStart, PAIRING_CI } from "../../src/p2p/cpace.ts";
import { generateKeyPair } from "../../src/p2p/noise.ts";
import {
  generatePairingCode,
  openPairingMessage,
  pairingKey,
  sealPairingMessage,
  type DeviceIdentity,
  type VaultInfo,
} from "../../src/p2p/pairing.ts";

function keys(codeExt: string, codePhone: string): { ext: Uint8Array; phone: Uint8Array } {
  const sid = randomBytes(16);
  const e = cpaceStart(utf8(codeExt), PAIRING_CI, sid, utf8("ext"));
  const p = cpaceStart(utf8(codePhone), PAIRING_CI, sid, utf8("phone"));
  return {
    ext: pairingKey(cpaceFinish(e.state, p.message, "initiator")),
    phone: pairingKey(cpaceFinish(p.state, e.message, "responder")),
  };
}

const identity = (): DeviceIdentity => ({
  deviceId: "phone-1",
  name: "Pixel",
  staticPublicKey: toBase64(generateKeyPair().publicKey),
});

const vaultInfo = (): VaultInfo => ({
  epoch: toBase64(randomBytes(16)),
  kdf: { alg: "argon2id", salt: toBase64(randomBytes(16)), memoryKiB: 65536, iterations: 3, parallelism: 4 },
  wrappedVaultKey: toBase64(randomBytes(60)),
  addresses: ["192.168.1.5:8443"],
});

describe("pairing", () => {
  it("generates 8 decimal digits with every digit possible", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{8}$/);
      for (const d of code) seen.add(d);
    }
    expect(seen.size).toBe(10);
  });

  it("a full pairing exchanges identities and vault info", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    expect(ext).toEqual(phone);
    const phoneId = identity();
    const extId = { ...identity(), deviceId: "ext-1", name: "Chrome" };
    const info = vaultInfo();
    expect(await openPairingMessage(ext, "identity", await sealPairingMessage(phone, "identity", phoneId))).toEqual(phoneId);
    expect(await openPairingMessage(ext, "vault-info", await sealPairingMessage(phone, "vault-info", info))).toEqual(info);
    expect(await openPairingMessage(phone, "identity", await sealPairingMessage(ext, "identity", extId))).toEqual(extId);
  });

  it("the wrong code makes the first message fail to open", async () => {
    const { ext, phone } = keys("12345678", "12345679");
    const blob = await sealPairingMessage(phone, "identity", identity());
    await expect(openPairingMessage(ext, "identity", blob)).rejects.toThrow();
  });

  it("a message sealed as identity does not open as vault-info", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    const blob = await sealPairingMessage(phone, "identity", identity());
    await expect(openPairingMessage(ext, "vault-info", blob)).rejects.toThrow();
  });

  it("rejects a static key that is not 32 bytes", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    const bad = { ...identity(), staticPublicKey: toBase64(randomBytes(31)) };
    const blob = await sealPairingMessage(phone, "identity", bad);
    await expect(openPairingMessage(ext, "identity", blob)).rejects.toThrow();
  });

  it("rejects invalid vault info fields", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    const cases: VaultInfo[] = [
      { ...vaultInfo(), epoch: toBase64(randomBytes(8)) },
      { ...vaultInfo(), epoch: "not base64!" },
      { ...vaultInfo(), addresses: [1 as unknown as string] },
      { ...vaultInfo(), kdf: { ...vaultInfo().kdf, iterations: 0 } },
      { ...vaultInfo(), wrappedVaultKey: "" },
    ];
    for (const c of cases) {
      const blob = await sealPairingMessage(phone, "vault-info", c);
      await expect(openPairingMessage(ext, "vault-info", blob)).rejects.toThrow();
    }
    const longId = { ...identity(), deviceId: "x".repeat(65) };
    await expect(openPairingMessage(ext, "identity", await sealPairingMessage(phone, "identity", longId))).rejects.toThrow();
  });
});
