import { describe, expect, it } from "vitest";
import { randomBytes, toBase64, utf8 } from "../../src/encoding.ts";
import { cpaceFinish, cpaceStart, PAIRING_CI } from "../../src/p2p/cpace.ts";
import { generateKeyPair } from "../../src/p2p/noise.ts";
import {
  generatePairingCode,
  openPairingMessage,
  pairingAad,
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
    expect(await openPairingMessage(ext, "identity", "responder", await sealPairingMessage(phone, "identity", "responder", phoneId))).toEqual(phoneId);
    expect(await openPairingMessage(ext, "vault-info", "responder", await sealPairingMessage(phone, "vault-info", "responder", info))).toEqual(info);
    expect(await openPairingMessage(phone, "identity", "initiator", await sealPairingMessage(ext, "identity", "initiator", extId))).toEqual(extId);
  });

  it("the wrong code makes the first message fail to open", async () => {
    const { ext, phone } = keys("12345678", "12345679");
    const blob = await sealPairingMessage(phone, "identity", "responder", identity());
    await expect(openPairingMessage(ext, "identity", "responder", blob)).rejects.toThrow();
  });

  it("a message sealed as identity does not open as vault-info", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    const blob = await sealPairingMessage(phone, "identity", "responder", identity());
    await expect(openPairingMessage(ext, "vault-info", "responder", blob)).rejects.toThrow();
  });

  it("a message sealed by the initiator does not open as sent by the responder", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    const blob = await sealPairingMessage(ext, "identity", "initiator", identity());
    await expect(openPairingMessage(phone, "identity", "responder", blob)).rejects.toThrow();
    // A reflected message: the initiator gets back its own message.
    await expect(openPairingMessage(ext, "identity", "responder", blob)).rejects.toThrow();
    expect(await openPairingMessage(phone, "identity", "initiator", blob)).toMatchObject({ name: "Pixel" });
    expect(pairingAad("vault-info", "responder")).toBe("passholder/v2/pair/vault-info/responder");
  });

  it("rejects a static key that is not 32 bytes", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    const bad = { ...identity(), staticPublicKey: toBase64(randomBytes(31)) };
    const blob = await sealPairingMessage(phone, "identity", "responder", bad);
    await expect(openPairingMessage(ext, "identity", "responder", blob)).rejects.toThrow();
  });

  it("rejects invalid vault info fields", async () => {
    const { ext, phone } = keys("12345678", "12345678");
    const cases: VaultInfo[] = [
      { ...vaultInfo(), epoch: toBase64(randomBytes(8)) },
      { ...vaultInfo(), epoch: "not base64!" },
      { ...vaultInfo(), addresses: [1 as unknown as string] },
      { ...vaultInfo(), kdf: { ...vaultInfo().kdf, iterations: 0 } },
      { ...vaultInfo(), wrappedVaultKey: "" },
      { ...vaultInfo(), kdf: { ...vaultInfo().kdf, salt: "AAECAwQFBgcICQoLDA0ODx==" } }, // non-canonical
      { ...vaultInfo(), addresses: Array.from({ length: 17 }, (_, i) => `10.0.0.${i}:1`) },
      { ...vaultInfo(), addresses: [""] },
      { ...vaultInfo(), addresses: ["a".repeat(257)] },
    ];
    for (const c of cases) {
      const blob = await sealPairingMessage(phone, "vault-info", "responder", c);
      await expect(openPairingMessage(ext, "vault-info", "responder", blob)).rejects.toThrow();
    }
    const ok = { ...vaultInfo(), addresses: Array.from({ length: 16 }, () => "a".repeat(256)) };
    expect(await openPairingMessage(ext, "vault-info", "responder", await sealPairingMessage(phone, "vault-info", "responder", ok))).toEqual(ok);
    for (const bad of [{ deviceId: "x".repeat(65) }, { name: "" }, { name: "n".repeat(65) }]) {
      const id = { ...identity(), ...bad };
      await expect(openPairingMessage(ext, "identity", "responder", await sealPairingMessage(phone, "identity", "responder", id))).rejects.toThrow();
    }
  });
});
