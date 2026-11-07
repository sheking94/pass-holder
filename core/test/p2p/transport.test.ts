import { describe, expect, it } from "vitest";
import { fromBase64, randomBytes, toBase64 } from "../../src/encoding.ts";
import { newVaultKey } from "../../src/vault.ts";
import {
  CipherState,
  emptyLogin,
  emptyVaultV2,
  type EntryContentV3,
  generateKeyPair,
  HlcClock,
  liveEntriesV2,
  NoiseKK,
  noiseTransport,
  P2P_HANDSHAKE_PATH,
  P2P_SYNC_PATH,
  PHONE_UPDATE_REQUIRED,
  P2P_PROLOGUE,
  P2pHost,
  processP2pSync,
  syncVaultV2,
  upsertEntryV2,
  type FetchJson,
  type PairedDevice,
} from "../../src/p2p/index.ts";
import { encryptFrames } from "../../src/p2p/frames.ts";
import { MemorySyncStore } from "../../src/protocol.ts";

const login = (name: string, password = "p"): EntryContentV3 => ({
  ...emptyLogin(name),
  fields: { username: "u", password, totp: "", urls: [], androidApps: [] },
});
const entry = (name: string) => login(name);

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
  const res = await s.host.handle("/p2p/v2/handshake", { deviceId, message });
  expect(res.status).toBe(200);
  const body = res.body as { session: string; message: string };
  await noise.readMessage(fromBase64(body.message));
  return { session: body.session, ciphers: noise.split() };
}

const syncBody = (ciphers: { send: CipherState }, epoch: string) =>
  encryptFrames(ciphers.send, { epoch, sinceRevision: 0, changes: [] });

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

  it("old paths answer 410", async () => {
    const s = setup();
    for (const path of ["/p2p/v1/handshake", "/p2p/v1/sync"])
      expect(await s.host.handle(path, {})).toEqual({ status: 410, body: { error: "update required" } });
  });

  it("transport uses v2 paths", async () => {
    const s = setup();
    const urls: string[] = [];
    const key = s.addDevice("a");
    const t = noiseTransport({
      baseUrl: "http://phone",
      deviceId: "a",
      staticKey: key,
      peerPublicKey: s.hostKey.publicKey,
      post: async (url, body) => (urls.push(url), s.post(url, body)),
    });
    await t({ epoch: s.epoch, sinceRevision: 0, changes: [] });
    expect(urls).toEqual(["http://phone/p2p/v2/handshake", "http://phone/p2p/v2/sync"]);
    expect(P2P_HANDSHAKE_PATH).toBe("/p2p/v2/handshake");
    expect(P2P_SYNC_PATH).toBe("/p2p/v2/sync");
  });

  it("404 on handshake means old phone", async () => {
    const s = setup();
    const t = noiseTransport({
      baseUrl: "http://phone",
      deviceId: "a",
      staticKey: s.addDevice("a"),
      peerPublicKey: s.hostKey.publicKey,
      post: async () => ({ status: 404, body: { error: "not found" } }),
    });
    await expect(t({ epoch: s.epoch, sinceRevision: 0, changes: [] })).rejects.toThrow(PHONE_UPDATE_REQUIRED);
    expect(PHONE_UPDATE_REQUIRED).toBe("Phone app needs an update");
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
    const ok = await s.host.handle("/p2p/v2/sync", { session: first.session, frames: await syncBody(first.ciphers, s.epoch) });
    expect(ok.status).toBe(200);
    const again = await s.host.handle("/p2p/v2/sync", { session: first.session, frames: await syncBody(first.ciphers, s.epoch) });
    expect(again.status).toBe(401);

    const second = await rawHandshake(s, "a", keyA);
    s.advance(61_000);
    const expired = await s.host.handle("/p2p/v2/sync", { session: second.session, frames: await syncBody(second.ciphers, s.epoch) });
    expect(expired.status).toBe(401);

    const unknown = await s.host.handle("/p2p/v2/sync", { session: toBase64(randomBytes(16)), frames: ["AA=="] });
    expect(unknown.status).toBe(401);
  });

  it("rejects a tampered sync ciphertext", async () => {
    const s = setup();
    const h = await rawHandshake(s, "a");
    const frames = await syncBody(h.ciphers, s.epoch);
    const ct = fromBase64(frames[0]!);
    ct[ct.length - 1]! ^= 1;
    const res = await s.host.handle("/p2p/v2/sync", { session: h.session, frames: [toBase64(ct)] });
    expect(res.status).toBe(400);
    expect(s.store.currentRevision()).toBe(0);
  });

  it("syncs a vault whose request exceeds 200 KiB across many frames", async () => {
    const s = setup();
    const vaultKey = newVaultKey();
    const a = emptyVaultV2();
    const b = emptyVaultV2();
    const clockA = new HlcClock("a", () => 1000);
    const clockB = new HlcClock("b", () => 1000);
    for (let i = 0; i < 600; i++)
      upsertEntryV2(a, clockA, `id${i}`, login(`n${i}`, "p".repeat(300)));
    await syncVaultV2(a, vaultKey, clockA, s.transportFor("a"));
    expect(s.store.currentRevision()).toBe(600);
    await syncVaultV2(b, vaultKey, clockB, s.transportFor("b"));
    expect(liveEntriesV2(b)).toHaveLength(600);
  });

  it("syncs 1300 entries to a fresh device through the host in pages", async () => {
    const s = setup();
    const vaultKey = newVaultKey();
    const a = emptyVaultV2();
    const b = emptyVaultV2();
    const clockA = new HlcClock("a", () => 1000);
    const clockB = new HlcClock("b", () => 1000);
    // Too large for one 1 MiB request: only works with paging.
    for (let i = 0; i < 1300; i++) upsertEntryV2(a, clockA, `id${i}`, login(`n${i}`, "p".repeat(800)));
    await syncVaultV2(a, vaultKey, clockA, s.transportFor("a"));
    expect(s.store.currentRevision()).toBe(1300);
    await syncVaultV2(b, vaultKey, clockB, s.transportFor("b"));
    expect(liveEntriesV2(b)).toHaveLength(1300);
    expect(b.lastSyncRevision).toBe(1300);
  });

  it("rejects a tampered middle frame and leaves the store unchanged", async () => {
    const s = setup();
    const h = await rawHandshake(s, "a");
    const changes = Array.from({ length: 400 }, (_, i) => ({ id: `x${i}`, junk: "z".repeat(400) }));
    const frames = await encryptFrames(h.ciphers.send, { epoch: s.epoch, sinceRevision: 0, changes });
    expect(frames.length).toBeGreaterThan(2);
    const mid = fromBase64(frames[1]!);
    mid[5]! ^= 1;
    frames[1] = toBase64(mid);
    const res = await s.host.handle("/p2p/v2/sync", { session: h.session, frames });
    expect(res.status).toBe(400);
    expect(s.store.currentRevision()).toBe(0);
  });

  it("rejects an oversized body", async () => {
    const s = setup();
    const res = await s.host.handle("/p2p/v2/sync", { session: "x", frames: ["A".repeat(1024 * 1024)] });
    expect(res.status).toBe(413);
  });

  it("maps malformed requests and unknown paths", async () => {
    const s = setup();
    expect((await s.host.handle("/p2p/v1/nope", {})).status).toBe(404);
    expect((await s.host.handle("/p2p/v2/handshake", { deviceId: 1 })).status).toBe(400);
    expect((await s.host.handle("/p2p/v2/sync", null)).status).toBe(400);
    s.addDevice("a");
    expect((await s.host.handle("/p2p/v2/handshake", { deviceId: "a", message: toBase64(randomBytes(48)) })).status).toBe(400);
  });
});

describe("p2p host: final review fixes", () => {
  const blob = toBase64(randomBytes(40));
  const change = (id: string, baseRevision = 0) => ({ id, baseRevision, deleted: false, blob });

  async function sendRaw(s: ReturnType<typeof setup>, request: unknown, key = s.addDevice(`d${Math.random()}`)) {
    const h = await rawHandshake(s, s.devices.at(-1)!.deviceId, key);
    return s.host.handle("/p2p/v2/sync", { session: h.session, frames: await encryptFrames(h.ciphers.send, request) });
  }

  it("a session opened before the device was removed cannot sync", async () => {
    const s = setup();
    const key = s.addDevice("a");
    const h = await rawHandshake(s, "a", key);
    s.devices.length = 0;
    const res = await s.host.handle("/p2p/v2/sync", { session: h.session, frames: await syncBody(h.ciphers, s.epoch) });
    expect(res).toEqual({ status: 403, body: { error: "device not paired" } });
    // The session is consumed even though the device comes back.
    s.devices.push({ deviceId: "a", name: "a", staticPublicKey: key.publicKey });
    const again = await s.host.handle("/p2p/v2/sync", { session: h.session, frames: await syncBody(h.ciphers, s.epoch) });
    expect(again.status).toBe(401);
  });

  it("a session opened before the device was re-paired with another key cannot sync", async () => {
    const s = setup();
    const h = await rawHandshake(s, "a");
    s.devices[0] = { deviceId: "a", name: "a", staticPublicKey: generateKeyPair().publicKey };
    const res = await s.host.handle("/p2p/v2/sync", { session: h.session, frames: await syncBody(h.ciphers, s.epoch) });
    expect(res.status).toBe(403);
  });

  it("rejects malformed or duplicate changes with 400 and leaves the store unchanged", async () => {
    const s = setup();
    const bad: unknown[] = [
      [change("ok"), { ...change("x"), id: 1 }],
      [change("ok"), change("")],
      [change("ok"), change("x".repeat(129))],
      [change("ok"), change("x", -1)],
      [change("ok"), change("x", 1.5)],
      [change("ok"), { ...change("x"), deleted: "no" }],
      [change("ok"), { ...change("x"), blob: 1 }],
      [change("ok"), null],
      [change("ok"), change("ok")],
    ];
    for (const changes of bad) {
      const res = await sendRaw(s, { epoch: s.epoch, sinceRevision: 0, changes });
      expect(res.status, JSON.stringify(changes)).toBe(400);
      expect(s.store.currentRevision()).toBe(0);
    }
    expect((await sendRaw(s, { epoch: s.epoch, sinceRevision: -1, changes: [] })).status).toBe(400);
    expect((await sendRaw(s, { epoch: s.epoch, sinceRevision: 0, changes: [change("x".repeat(128))] })).status).toBe(200);
  });

  it("an unknown base revision for an unknown id is a 400 before any write", async () => {
    const s = setup();
    const res = await sendRaw(s, { epoch: s.epoch, sinceRevision: 0, changes: [change("a"), change("ghost", 5)] });
    expect(res).toEqual({ status: 400, body: { error: "unknown base revision" } });
    expect(s.store.currentRevision()).toBe(0);
    // From another epoch nothing is processed, so the base revision does not matter.
    expect((await sendRaw(s, { epoch: "", sinceRevision: 0, changes: [change("ghost", 5)] })).status).toBe(200);
  });

  it("processP2pSync refuses an invalid request without writing", () => {
    const s = setup();
    expect(() => processP2pSync(s.store, s.epoch, [], { epoch: s.epoch, sinceRevision: 0, changes: [change("a"), change("a")] })).toThrow();
    expect(() => processP2pSync(s.store, s.epoch, [], { epoch: s.epoch, sinceRevision: 0, changes: [change("a"), change("b", 2)] })).toThrow(
      "unknown base revision",
    );
    expect(s.store.currentRevision()).toBe(0);
  });

  it("processP2pSync ignores a request whose sinceRevision is ahead of the store: no validation against the store, no writes", () => {
    const s = setup();
    s.store.put({ id: "known", revision: 1, deleted: false, blob });
    const res = processP2pSync(s.store, s.epoch, ["a:1"], {
      epoch: s.epoch,
      sinceRevision: 5,
      changes: [change("ghost", 3), change("fresh")],
    });
    expect(res).toEqual({ epoch: s.epoch, currentRevision: 1, accepted: [], conflicts: [], changes: [], addresses: ["a:1"], more: false });
    expect(s.store.currentRevision()).toBe(1);
    expect(s.store.get("fresh")).toBeUndefined();
    // Malformed requests are still refused.
    expect(() => processP2pSync(s.store, s.epoch, [], { epoch: s.epoch, sinceRevision: 5, changes: [change("a"), change("a")] })).toThrow();
  });

  it("a restored phone with an unknown id edited by the client does not leave the client stuck", async () => {
    const s = setup();
    const vaultKey = newVaultKey();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    const send = s.transportFor("ext");
    upsertEntryV2(ext, clock, "early", entry("E"));
    await syncVaultV2(ext, vaultKey, clock, send);
    const backup = new MemorySyncStore();
    for (const r of s.store.listSince(0)) backup.put(r);
    upsertEntryV2(ext, clock, "late", entry("L"));
    await syncVaultV2(ext, vaultKey, clock, send);
    // The phone is restored from the older backup, which does not know "late".
    Object.assign(s.store, { records: new Map((backup as any).records), revision: backup.currentRevision() });
    upsertEntryV2(ext, clock, "late", login("L", "p2"));
    await syncVaultV2(ext, vaultKey, clock, send);
    const phone = emptyVaultV2();
    await syncVaultV2(phone, vaultKey, new HlcClock("p", () => 1000), s.transportFor("phone"));
    expect(liveEntriesV2(phone).map((e) => [e.id, (e.data.fields as { password: string }).password]).sort()).toEqual([["early", "p"], ["late", "p2"]]);
  });

  it("holds at most 32 live sessions and answers 503 when full", async () => {
    const s = setup();
    const key = s.addDevice("a");
    for (let i = 0; i < 32; i++) await rawHandshake(s, "a", key);
    const noise = NoiseKK.initiator({ s: key, rs: s.hostKey.publicKey, prologue: P2P_PROLOGUE });
    const message = toBase64(await noise.writeMessage(new Uint8Array()));
    expect(await s.host.handle("/p2p/v2/handshake", { deviceId: "a", message })).toEqual({
      status: 503,
      body: { error: "too many sessions" },
    });
    s.advance(61_000);
    await rawHandshake(s, "a", key);
  });
});
