import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "../../src/encoding.ts";
import {
  MAX_FILE_BLOB_LENGTH,
  MemoryFileStore,
  ORPHAN_FILE_AGE_MS,
  orphanFileIds,
  processP2pFile,
} from "../../src/files/index.ts";
import { generateKeyPair, NoiseKK, P2P_PROLOGUE, P2pHost, type PairedDevice } from "../../src/p2p/index.ts";
import { decryptFrames, encryptFrames } from "../../src/p2p/frames.ts";
import { P2P_FILE_PATH } from "../../src/p2p/transport.ts";
import { MemorySyncStore } from "../../src/protocol.ts";

const EPOCH = "epoch-1";
const ID = "123e4567-e89b-42d3-a456-426614174000";
const ID2 = "223e4567-e89b-42d3-a456-426614174000";
const put = (id: string, index: number, chunks: number, blob: string, epoch = EPOCH) => ({
  op: "put",
  epoch,
  id,
  index,
  chunks,
  blob,
});

describe("processP2pFile", () => {
  it("stores chunks and reports status", () => {
    const store = new MemoryFileStore();
    expect(processP2pFile(store, EPOCH, put(ID, 0, 2, "AAAA"), 5)).toEqual({ status: 200, body: { have: 1 } });
    expect(processP2pFile(store, EPOCH, { op: "status", epoch: EPOCH, ids: [ID, ID2] }, 5).body).toEqual({
      files: [
        { id: ID, chunks: 2, have: [0], complete: false },
        { id: ID2, chunks: 0, have: [], complete: false },
      ],
    });
    expect(processP2pFile(store, EPOCH, put(ID, 1, 2, "BBBB"), 6).body).toEqual({ have: 2 });
    expect(processP2pFile(store, EPOCH, { op: "status", epoch: EPOCH, ids: [ID] }, 7).body).toEqual({
      files: [{ id: ID, chunks: 2, have: [0, 1], complete: true }],
    });
    expect(store.createdAt(ID)).toBe(5);
  });

  it("sorts have ascending", () => {
    const store = new MemoryFileStore();
    processP2pFile(store, EPOCH, put(ID, 2, 3, "C"), 1);
    processP2pFile(store, EPOCH, put(ID, 0, 3, "A"), 1);
    expect(store.have(ID)).toEqual([0, 2]);
  });

  it("accepts an identical chunk, rejects a different one and a chunk count change", () => {
    const store = new MemoryFileStore();
    processP2pFile(store, EPOCH, put(ID, 0, 2, "AAAA"), 1);
    expect(processP2pFile(store, EPOCH, put(ID, 0, 2, "AAAA"), 2)).toEqual({ status: 200, body: { have: 1 } });
    expect(processP2pFile(store, EPOCH, put(ID, 0, 2, "BBBB"), 2)).toEqual({
      status: 409,
      body: { error: "chunk differs" },
    });
    expect(processP2pFile(store, EPOCH, put(ID, 1, 3, "CCCC"), 2)).toEqual({
      status: 400,
      body: { error: "chunk count mismatch" },
    });
    expect(store.get(ID, 0)).toBe("AAAA");
  });

  it("gets chunks and reports missing ones", () => {
    const store = new MemoryFileStore();
    processP2pFile(store, EPOCH, put(ID, 0, 2, "AAAA"), 1);
    expect(processP2pFile(store, EPOCH, { op: "get", epoch: EPOCH, id: ID, index: 0 }, 2)).toEqual({
      status: 200,
      body: { chunks: 2, blob: "AAAA" },
    });
    for (const [id, index] of [[ID, 1], [ID2, 0]] as const)
      expect(processP2pFile(store, EPOCH, { op: "get", epoch: EPOCH, id, index }, 2)).toEqual({
        status: 404,
        body: { error: "chunk not found" },
      });
  });

  it("answers another epoch with the epoch and changes nothing", () => {
    const store = new MemoryFileStore();
    for (const req of [
      put(ID, 0, 1, "AAAA", "other"),
      { op: "status", epoch: "other", ids: [ID] },
      { op: "get", epoch: "other", id: ID, index: 0 },
    ])
      expect(processP2pFile(store, EPOCH, req, 1)).toEqual({ status: 200, body: { epoch: EPOCH } });
    expect(store.ids()).toEqual([]);
  });

  it("rejects malformed requests", () => {
    const store = new MemoryFileStore();
    const ok = put(ID, 0, 2, "AAAA");
    const bad: unknown[] = [
      null,
      "x",
      { ...ok, op: "delete" },
      { ...ok, epoch: 1 },
      { ...ok, id: "not-a-uuid" },
      { ...ok, id: ID.toUpperCase() },
      { ...ok, index: -1 },
      { ...ok, index: 2 },
      { ...ok, index: 0.5 },
      { ...ok, chunks: 0 },
      { ...ok, chunks: 41 },
      { ...ok, blob: "A".repeat(MAX_FILE_BLOB_LENGTH + 1) },
      { ...ok, blob: 5 },
      { op: "get", epoch: EPOCH, id: "x", index: 0 },
      { op: "get", epoch: EPOCH, id: ID },
      { op: "status", epoch: EPOCH, ids: Array.from({ length: 501 }, () => ID) },
      { op: "status", epoch: EPOCH, ids: [ID, "nope"] },
      { op: "status", epoch: EPOCH, ids: "x" },
    ];
    for (const req of bad)
      expect(processP2pFile(store, EPOCH, req, 1), JSON.stringify(req)).toEqual({
        status: 400,
        body: { error: "malformed file request" },
      });
    expect(processP2pFile(store, EPOCH, put(ID, 0, 2, "A".repeat(MAX_FILE_BLOB_LENGTH)), 1).status).toBe(200);
    expect(
      processP2pFile(store, EPOCH, { op: "status", epoch: EPOCH, ids: Array.from({ length: 500 }, () => ID) }, 1).status,
    ).toBe(200);
  });

  it("reports insufficient storage without writing", () => {
    const store = new MemoryFileStore(10);
    expect(processP2pFile(store, EPOCH, put(ID, 0, 2, "A".repeat(8)), 1).status).toBe(200);
    expect(processP2pFile(store, EPOCH, put(ID, 1, 2, "B".repeat(3)), 1)).toEqual({
      status: 507,
      body: { error: "insufficient storage" },
    });
    expect(store.have(ID)).toEqual([0]);
    // Re-putting an identical chunk needs no space.
    expect(processP2pFile(store, EPOCH, put(ID, 0, 2, "A".repeat(8)), 1).status).toBe(200);
    expect(processP2pFile(store, EPOCH, put(ID, 1, 2, "B".repeat(2)), 1).status).toBe(200);
  });
});

describe("MemoryFileStore", () => {
  it("deletes and clears", () => {
    const store = new MemoryFileStore();
    store.put(ID, 0, 1, "A", 1);
    store.put(ID2, 0, 1, "A", 1);
    store.delete(ID);
    expect(store.ids()).toEqual([ID2]);
    expect(store.chunks(ID)).toBeUndefined();
    store.clear();
    expect(store.ids()).toEqual([]);
  });
});

describe("orphanFileIds", () => {
  it("lists unused files older than 24 h", () => {
    const store = new MemoryFileStore();
    store.put(ID, 0, 1, "A", 1000);
    const used = new Set<string>();
    expect(orphanFileIds(store, used, 1000 + ORPHAN_FILE_AGE_MS - 1)).toEqual([]);
    expect(orphanFileIds(store, used, 1000 + ORPHAN_FILE_AGE_MS + 1)).toEqual([ID]);
    expect(orphanFileIds(store, new Set([ID]), 1000 + ORPHAN_FILE_AGE_MS + 1)).toEqual([]);
  });
});

describe("P2pHost file path", () => {
  function setup(files: MemoryFileStore | undefined) {
    const hostKey = generateKeyPair();
    const clientKey = generateKeyPair();
    const devices: PairedDevice[] = [{ deviceId: "d1", name: "d1", staticPublicKey: clientKey.publicKey }];
    const host = new P2pHost({
      staticKey: hostKey,
      devices: () => devices,
      store: new MemorySyncStore(),
      epoch: EPOCH,
      addresses: () => [],
      files,
    });
    const handshake = async () => {
      const noise = NoiseKK.initiator({ s: clientKey, rs: hostKey.publicKey, prologue: P2P_PROLOGUE });
      const message = toBase64(await noise.writeMessage(new Uint8Array()));
      const res = await host.handle("/p2p/v2/handshake", { deviceId: "d1", message });
      const body = res.body as { session: string; message: string };
      await noise.readMessage(fromBase64(body.message));
      return { session: body.session, ciphers: noise.split() };
    };
    return { host, handshake, devices };
  }

  it("uses the documented path", () => {
    expect(P2P_FILE_PATH).toBe("/p2p/v2/file");
  });

  it("serves put and get through an encrypted session", async () => {
    const files = new MemoryFileStore();
    const s = setup(files);
    const a = await s.handshake();
    const res = await s.host.handle(P2P_FILE_PATH, {
      session: a.session,
      frames: await encryptFrames(a.ciphers.send, put(ID, 0, 1, "AAAA")),
    });
    expect(res.status).toBe(200);
    expect(await decryptFrames(a.ciphers.recv, (res.body as { frames: string[] }).frames)).toEqual({ have: 1 });
    const b = await s.handshake();
    const got = await s.host.handle(P2P_FILE_PATH, {
      session: b.session,
      frames: await encryptFrames(b.ciphers.send, { op: "get", epoch: EPOCH, id: ID, index: 0 }),
    });
    expect(await decryptFrames(b.ciphers.recv, (got.body as { frames: string[] }).frames)).toEqual({
      chunks: 1,
      blob: "AAAA",
    });
  });

  it("returns errors in plaintext and spends the session", async () => {
    const s = setup(new MemoryFileStore());
    const a = await s.handshake();
    const frames = await encryptFrames(a.ciphers.send, { op: "get", epoch: EPOCH, id: ID, index: 0 });
    expect(await s.host.handle(P2P_FILE_PATH, { session: a.session, frames })).toEqual({
      status: 404,
      body: { error: "chunk not found" },
    });
    expect((await s.host.handle(P2P_FILE_PATH, { session: a.session, frames })).status).toBe(401);
  });

  it("answers 404 not found without a file store", async () => {
    const s = setup(undefined);
    const a = await s.handshake();
    const frames = await encryptFrames(a.ciphers.send, { op: "status", epoch: EPOCH, ids: [] });
    expect(await s.host.handle(P2P_FILE_PATH, { session: a.session, frames })).toEqual({
      status: 404,
      body: { error: "not found" },
    });
  });

  it("rejects an unknown session and an unpaired device", async () => {
    const s = setup(new MemoryFileStore());
    const frames = await encryptFrames((await s.handshake()).ciphers.send, { op: "status", epoch: EPOCH, ids: [] });
    expect((await s.host.handle(P2P_FILE_PATH, { session: "nope", frames })).status).toBe(401);
    const a = await s.handshake();
    s.devices.length = 0;
    const f2 = await encryptFrames(a.ciphers.send, { op: "status", epoch: EPOCH, ids: [] });
    expect((await s.host.handle(P2P_FILE_PATH, { session: a.session, frames: f2 })).status).toBe(403);
  });
});
