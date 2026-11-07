import { describe, expect, it } from "vitest";
import { fromBase64, randomBytes, toBase64, utf8 } from "../../src/encoding.ts";
import {
  cpaceFinish,
  cpaceStart,
  generateKeyPair,
  lvCat,
  openPairingMessage,
  pairingKey,
  PAIRING_CI,
  pairWithPhone,
  phoneHello,
  pingPhone,
  sealPairingMessage,
  type DeviceIdentity,
  type FetchJson,
  type PhoneMode,
  type VaultInfo,
} from "../../src/p2p/index.ts";

const BASE = "http://192.168.1.5:8787";

const vaultInfo = (addresses: string[]): VaultInfo => ({
  epoch: toBase64(randomBytes(16)),
  kdf: { alg: "argon2id", salt: toBase64(randomBytes(16)), memoryKiB: 65536, iterations: 3, parallelism: 4 },
  wrappedVaultKey: toBase64(randomBytes(60)),
  addresses,
});

const extIdentity: DeviceIdentity = {
  deviceId: "ext-1",
  name: "Chrome",
  staticPublicKey: toBase64(generateKeyPair().publicKey),
};

/** A fake phone host implementing the pairing table of the protocol, with real CPace as the responder. */
function fakePhone(mode: PhoneMode | null, code = "12345678") {
  const identity: DeviceIdentity = { deviceId: "phone-1", name: "Telefon", staticPublicKey: toBase64(generateKeyPair().publicKey) };
  const info = vaultInfo(["http://192.168.1.5:8787"]);
  const sid = toBase64(randomBytes(16));
  let offer = mode !== null;
  let key: Uint8Array | null = null;
  const calls: string[] = [];
  const got: { identity?: DeviceIdentity; vaultInfo?: VaultInfo; ad?: Uint8Array } = {};
  const fail = (status: number, error: string) => ({ status, body: { error } });

  const post: FetchJson = async (url, raw) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const body = structuredClone(raw) as Record<string, unknown>;
    switch (path) {
      case "/p2p/v1/ping":
        return { status: 200, body: { ok: true } };
      case "/p2p/v1/pair/hello":
        return offer ? { status: 200, body: { sid, mode } } : fail(404, "no pairing");
      case "/p2p/v1/pair/start": {
        if (typeof body.sid !== "string" || typeof body.message !== "string") return fail(400, "malformed request");
        if (!offer || body.sid !== sid) return fail(404, "no pairing");
        offer = false;
        const message = fromBase64(body.message);
        // lv_cat(Ya, adA): one length byte for the 32-byte element, then the ad field.
        got.ad = message.subarray(33);
        const cpace = cpaceStart(utf8(code), PAIRING_CI, fromBase64(sid), utf8(identity.deviceId));
        try {
          key = pairingKey(cpaceFinish(cpace.state, message, "responder"));
        } catch {
          return fail(400, "pairing failed");
        }
        return { status: 200, body: { message: toBase64(cpace.message) } };
      }
      case "/p2p/v1/pair/finish": {
        if (typeof body.sid !== "string" || typeof body.identity !== "string") return fail(400, "malformed request");
        const k = key;
        key = null;
        if (k === null || body.sid !== sid) return fail(404, "no pairing");
        if ((mode === "restore") !== (body.vaultInfo !== undefined)) return fail(400, "malformed request");
        try {
          got.identity = (await openPairingMessage(k, "identity", "initiator", body.identity)) as DeviceIdentity;
          if (typeof body.vaultInfo === "string")
            got.vaultInfo = (await openPairingMessage(k, "vault-info", "initiator", body.vaultInfo)) as VaultInfo;
        } catch {
          return fail(403, "pairing failed");
        }
        return {
          status: 200,
          body: {
            identity: await sealPairingMessage(k, "identity", "responder", identity),
            vaultInfo: await sealPairingMessage(k, "vault-info", "responder", info),
          },
        };
      }
      default:
        return fail(404, "not found");
    }
  };
  return { post, identity, info, sid, calls, got };
}

describe("pairing client", () => {
  it("hello returns the offer's sid and mode", async () => {
    const phone = fakePhone("pair");
    expect(await phoneHello(BASE, phone.post)).toEqual({ sid: phone.sid, mode: "pair" });
    expect(phone.calls).toEqual(["/p2p/v1/pair/hello"]);
  });

  it("pairs with the right code", async () => {
    const phone = fakePhone("pair");
    const res = await pairWithPhone({ baseUrl: `${BASE}/`, code: "12345678", identity: extIdentity, post: phone.post });
    expect(res.mode).toBe("pair");
    expect(res.phone).toEqual(phone.identity);
    expect(res.phone.staticPublicKey).toBe(phone.identity.staticPublicKey);
    expect(res.vaultInfo).toEqual(phone.info);
    expect(phone.got.identity).toEqual(extIdentity);
    expect(phone.got.vaultInfo).toBeUndefined();
    // CPace ad of the extension is the UTF-8 of its deviceId.
    expect(phone.got.ad).toEqual(lvCat(utf8(extIdentity.deviceId)));
    expect(phone.calls).toEqual(["/p2p/v1/pair/hello", "/p2p/v1/pair/start", "/p2p/v1/pair/finish"]);
  });

  it("accepts a code typed with spaces", async () => {
    const phone = fakePhone("pair");
    const res = await pairWithPhone({ baseUrl: BASE, code: " 1234 5678 ", identity: extIdentity, post: phone.post });
    expect(res.phone).toEqual(phone.identity);
  });

  it("a wrong code gives the wrong-code message", async () => {
    const phone = fakePhone("pair");
    await expect(pairWithPhone({ baseUrl: BASE, code: "87654321", identity: extIdentity, post: phone.post })).rejects.toThrow(
      "Zły kod parowania. Poproś telefon o nowy kod.",
    );
    expect(phone.got.identity).toBeUndefined();
  });

  it("a code that is not 8 digits is refused before /start, so the code is not spent", async () => {
    const phone = fakePhone("pair");
    await expect(pairWithPhone({ baseUrl: BASE, code: "1234567", identity: extIdentity, post: phone.post })).rejects.toThrow(
      "Kod parowania to 8 cyfr.",
    );
    expect(phone.calls).not.toContain("/p2p/v1/pair/start");
  });

  it("restore sends the extension's vault info", async () => {
    const phone = fakePhone("restore");
    const mine = vaultInfo([]);
    const res = await pairWithPhone({ baseUrl: BASE, code: "12345678", identity: extIdentity, post: phone.post, restore: mine });
    expect(res.mode).toBe("restore");
    expect(phone.got.vaultInfo).toEqual(mine);
    expect(res.vaultInfo).toEqual(phone.info);
  });

  it("restore mode without a vault to restore fails before /start", async () => {
    const phone = fakePhone("restore");
    await expect(pairWithPhone({ baseUrl: BASE, code: "12345678", identity: extIdentity, post: phone.post })).rejects.toThrow(
      "Telefon czeka na odtworzenie sejfu z wtyczki",
    );
    expect(phone.calls).toEqual(["/p2p/v1/pair/hello"]);
  });

  it("pair mode ignores a vault to restore (the phone already has one)", async () => {
    const phone = fakePhone("pair");
    const res = await pairWithPhone({ baseUrl: BASE, code: "12345678", identity: extIdentity, post: phone.post, restore: vaultInfo([]) });
    expect(res.mode).toBe("pair");
    expect(phone.got.vaultInfo).toBeUndefined();
  });

  it("no offer on the phone gives the expired message", async () => {
    const phone = fakePhone(null);
    await expect(pairWithPhone({ baseUrl: BASE, code: "12345678", identity: extIdentity, post: phone.post })).rejects.toThrow(
      "Telefon nie czeka na parowanie albo kod wygasł.",
    );
    await expect(phoneHello(BASE, phone.post)).rejects.toThrow("Telefon nie czeka na parowanie albo kod wygasł.");
  });

  it("404 on /start and /finish gives the expired message", async () => {
    for (const failing of ["/p2p/v1/pair/start", "/p2p/v1/pair/finish"]) {
      const phone = fakePhone("pair");
      const post: FetchJson = async (url, body) =>
        new URL(url).pathname === failing ? { status: 404, body: { error: "no pairing" } } : phone.post(url, body);
      await expect(pairWithPhone({ baseUrl: BASE, code: "12345678", identity: extIdentity, post })).rejects.toThrow(
        "Telefon nie czeka na parowanie albo kod wygasł.",
      );
    }
  });

  it("other errors carry the host's error text", async () => {
    const phone = fakePhone("pair");
    const post: FetchJson = async (url, body) =>
      new URL(url).pathname === "/p2p/v1/pair/finish" ? { status: 500, body: { error: "internal error" } } : phone.post(url, body);
    await expect(pairWithPhone({ baseUrl: BASE, code: "12345678", identity: extIdentity, post })).rejects.toThrow(
      "P2P host returned 500: internal error",
    );
    const forbidden: FetchJson = async () => ({ status: 403, body: { error: "forbidden host" } });
    await expect(phoneHello(BASE, forbidden)).rejects.toThrow("P2P host returned 403: forbidden host");
  });

  it("refuses malformed answers", async () => {
    const answers: unknown[] = [{ sid: 1, mode: "pair" }, { sid: toBase64(randomBytes(16)), mode: "other" }, null];
    for (const body of answers) {
      await expect(phoneHello(BASE, async () => ({ status: 200, body }))).rejects.toThrow("P2P host returned a malformed response");
    }
  });

  it("ping checks the host answers ok", async () => {
    const phone = fakePhone(null);
    await expect(pingPhone(BASE, phone.post)).resolves.toBeUndefined();
    expect(phone.calls).toEqual(["/p2p/v1/ping"]);
    await expect(pingPhone(BASE, async () => ({ status: 200, body: {} }))).rejects.toThrow("P2P host returned a malformed response");
    await expect(pingPhone(BASE, async () => ({ status: 404, body: { error: "not found" } }))).rejects.toThrow(
      "P2P host returned 404: not found",
    );
  });
});
