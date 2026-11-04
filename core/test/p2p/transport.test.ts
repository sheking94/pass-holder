import { describe, expect, it } from "vitest";
import { fromBase64, randomBytes, toBase64, utf8 } from "../../src/encoding.ts";
import { newVaultKey } from "../../src/vault.ts";
import {
  emptyVaultV2,
  generateKeyPair,
  HlcClock,
  liveEntriesV2,
  NoiseKK,
  noiseTransport,
  P2P_PROLOGUE,
  P2pHost,
  syncVaultV2,
  upsertEntryV2,
  type FetchJson,
  type PairedDevice,
} from "../../src/p2p/index.ts";
import { MemorySyncStore } from "../../src/protocol.ts";

const entry = (name: string) => ({ name, username: "u", password: "p" });

function setup() {
  const store = new MemorySyncStore();
  const epoch = toBase64(randomBytes(16));
  const hostKey = generateKeyPair();
  const devices: PairedDevice[] = [];
  let time = 1_000_000;
  const host = new P2pHost({
    staticKey: hostKey,
    devices: () => devices,
    store,
    epoch,
    addresses: () => ["192.168.1.5:8787"],
    now: () => time,
  });
  const post: FetchJson = async (url, body) => {
    const path = new URL(url).pathname;
    const res = await host.handle(path, structuredClone(body));
    return structuredClone(res);
  };
  const addDevice = (deviceId: string) => {
    const key = generateKeyPair();
    devices.push({ deviceId, name: deviceId, staticPublicKey: key.publicKey });
    return key;
  };
  const transportFor = (deviceId: string, key = addDevice(deviceId)) =>
    noiseTransport({ baseUrl: "http://phone", deviceId, staticKey: key, peerPublicKey: hostKey.publicKey, post });
  return { store, epoch, hostKey, devices, host, post, addDevice, transportFor, advance: (ms: number) => (time += ms) };
}

/** Performs a handshake by hand and returns what is needed to send /sync. */
async function rawHandshake(s: ReturnType<typeof setup>, deviceId: string, key = s.addDevice(deviceId)) {
  const noise = NoiseKK.initiator({ s: key, rs: s.hostKey.publicKey, prologue: P2P_PROLOGUE });
  const message = toBase64(await noise.writeMessage(new Uint8Array()));
  const res = await s.host.handle("/p2p/v1/handshake", { deviceId, message });
  expect(res.status).toBe(200);
  const body = res.body as { session: string; message: string };
  await noise.readMessage(fromBase64(body.message));
  return { session: body.session, ciphers: noise.split() };
}

const syncBody = async (ciphers: { send: { encrypt(ad: Uint8Array, pt: Uint8Array): Promise<Uint8Array> } }, epoch: string) =>
  toBase64(await ciphers.send.encrypt(new Uint8Array(), utf8(JSON.stringify({ epoch, sinceRevision: 0, changes: [] }))));

describe("p2p noise transport", () => {
  it("syncs two vaults through the host", async () => {
    const s = setup();
    const vaultKey = newVaultKey();
    const a = emptyVaultV2();
    const b = emptyVaultV2();
    const clockA = new HlcClock("a", () => 1000);
    const clockB = new HlcClock("b", () => 1000);
    const sendA = s.transportFor("a");
    const sendB = s.transportFor("b");

    upsertEntryV2(a, clockA, "1", entry("Bank"));
    await syncVaultV2(a, vaultKey, clockA, sendA);
    await syncVaultV2(b, vaultKey, clockB, sendB);

    expect(liveEntriesV2(b).map((e) => e.data.name)).toEqual(["Bank"]);
    expect(b.epoch).toBe(s.epoch);
    expect(b.addresses).toEqual(["192.168.1.5:8787"]);
  });

  it("refuses a device that is not paired or was removed", async () => {
    const s = setup();
    const stranger = noiseTransport({
      baseUrl: "http://phone",
      deviceId: "nobody",
      staticKey: generateKeyPair(),
      peerPublicKey: s.hostKey.publicKey,
      post: s.post,
    });
    const request = { epoch: s.epoch, sinceRevision: 0, changes: [] };
    await expect(stranger(request)).rejects.toThrow(/403/);

    const send = s.transportFor("a");
    await expect(send(request)).resolves.toMatchObject({ epoch: s.epoch });
    s.devices.length = 0;
    await expect(send(request)).rejects.toThrow(/403/);
  });

  it("rejects a reused, expired or unknown session", async () => {
    const s = setup();
    const keyA = s.addDevice("a");
    const first = await rawHandshake(s, "a", keyA);
    const ok = await s.host.handle("/p2p/v1/sync", { session: first.session, ciphertext: await syncBody(first.ciphers, s.epoch) });
    expect(ok.status).toBe(200);
    const again = await s.host.handle("/p2p/v1/sync", { session: first.session, ciphertext: await syncBody(first.ciphers, s.epoch) });
    expect(again.status).toBe(401);

    const second = await rawHandshake(s, "a", keyA);
    s.advance(61_000);
    const expired = await s.host.handle("/p2p/v1/sync", { session: second.session, ciphertext: await syncBody(second.ciphers, s.epoch) });
    expect(expired.status).toBe(401);

    const unknown = await s.host.handle("/p2p/v1/sync", { session: toBase64(randomBytes(16)), ciphertext: "AA==" });
    expect(unknown.status).toBe(401);
  });

  it("rejects a tampered sync ciphertext", async () => {
    const s = setup();
    const h = await rawHandshake(s, "a");
    const ct = fromBase64(await syncBody(h.ciphers, s.epoch));
    ct[ct.length - 1]! ^= 1;
    const res = await s.host.handle("/p2p/v1/sync", { session: h.session, ciphertext: toBase64(ct) });
    expect(res.status).toBe(400);
    expect(s.store.currentRevision()).toBe(0);
  });

  it("rejects an oversized body", async () => {
    const s = setup();
    const res = await s.host.handle("/p2p/v1/sync", { session: "x", ciphertext: "A".repeat(1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("maps malformed requests and unknown paths", async () => {
    const s = setup();
    expect((await s.host.handle("/p2p/v1/nope", {})).status).toBe(404);
    expect((await s.host.handle("/p2p/v1/handshake", { deviceId: 1 })).status).toBe(400);
    expect((await s.host.handle("/p2p/v1/sync", null)).status).toBe(400);
    s.addDevice("a");
    expect((await s.host.handle("/p2p/v1/handshake", { deviceId: "a", message: toBase64(randomBytes(48)) })).status).toBe(400);
  });
});
