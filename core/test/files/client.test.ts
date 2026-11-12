import { describe, expect, it } from "vitest";
import { randomBytes, toBase64 } from "../../src/encoding.ts";
import {
  decryptFile,
  encryptFile,
  FILE_CHUNK_SIZE,
  FILE_SYNC_EPOCH_MISMATCH,
  MemoryFileStore,
  MemoryLocalFileStore,
  noiseFileTransport,
  pruneLocalFiles,
  storeEncryptedFile,
  syncFiles,
  usedAttachments,
  type Attachment,
  type EncryptedFile,
  type LocalFileStore,
  type P2pFileRequest,
  type P2pFileTransport,
} from "../../src/files/index.ts";
import {
  applyVaultInfo,
  deleteEntryV2,
  emptyLogin,
  emptyVaultV2,
  generateKeyPair,
  HlcClock,
  P2pHost,
  PHONE_UPDATE_REQUIRED,
  upsertEntryV2,
  type FetchJson,
  type LocalVaultV2,
  type PairedDevice,
} from "../../src/p2p/index.ts";
import { MemorySyncStore } from "../../src/protocol.ts";

const sample = (length: number, seed = 7) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);
const newEpoch = () => toBase64(randomBytes(16));

/** A phone (real P2pHost) with its file store, and a transport factory for paired plugins. */
function phone(o: { epoch?: string; files?: MemoryFileStore | null } = {}) {
  const epoch = o.epoch ?? newEpoch();
  const files = o.files === null ? undefined : (o.files ?? new MemoryFileStore());
  const hostKey = generateKeyPair();
  const devices: PairedDevice[] = [];
  const host = new P2pHost({
    staticKey: hostKey,
    devices: () => devices,
    store: new MemorySyncStore(),
    epoch,
    addresses: () => [],
    files,
  });
  const post: FetchJson = async (url, body) => structuredClone(await host.handle(new URL(url).pathname, structuredClone(body)));
  /** Transport of a newly paired plugin; `ops` records every request sent through it. */
  const plugin = (deviceId: string) => {
    const key = generateKeyPair();
    devices.push({ deviceId, name: deviceId, staticPublicKey: key.publicKey });
    const inner = noiseFileTransport({ baseUrl: "http://phone/", deviceId, staticKey: key, peerPublicKey: hostKey.publicKey, post });
    const ops: P2pFileRequest[] = [];
    const send: P2pFileTransport = (r) => {
      ops.push(r);
      return inner(r);
    };
    return { send, ops, count: (op: P2pFileRequest["op"]) => ops.filter((r) => r.op === op).length };
  };
  return { epoch, files, host, plugin };
}

function vaultWith(epoch: string, attachments: Attachment[], name = "entry"): LocalVaultV2 {
  const vault = emptyVaultV2();
  applyVaultInfo(vault, { epoch, addresses: [] });
  upsertEntryV2(vault, new HlcClock("dev"), "e1", { ...emptyLogin(name), attachments });
  return vault;
}

async function localBlobs(files: LocalFileStore, a: Attachment): Promise<string[]> {
  const blobs: string[] = [];
  for (let i = 0; i < a.chunks; i++) blobs.push((await files.getChunk(a.id, i))!);
  return blobs;
}

/** Fails the n-th call (1-based) of `op`, passing everything else through. */
function failingAt(send: P2pFileTransport, op: P2pFileRequest["op"], n: number): P2pFileTransport {
  let seen = 0;
  return (r) => {
    if (r.op === op && ++seen === n) return Promise.reject(new Error("network down"));
    return send(r);
  };
}

const threeChunks = () => encryptFile(sample(FILE_CHUNK_SIZE * 2 + 10), { name: "scan.pdf", mime: "application/pdf" });

async function uploadedFrom(p: ReturnType<typeof phone>, f: EncryptedFile) {
  const files = new MemoryLocalFileStore();
  await storeEncryptedFile(files, f);
  const vault = vaultWith(p.epoch, [f.attachment]);
  await syncFiles(vault, files, p.plugin("a").send);
  return { files, vault };
}

describe("MemoryLocalFileStore / storeEncryptedFile", () => {
  it("stores a complete, not yet uploaded file", async () => {
    const f = await threeChunks();
    const files = new MemoryLocalFileStore();
    await storeEncryptedFile(files, f);
    expect(await files.state(f.attachment.id)).toEqual({
      id: f.attachment.id, chunks: 3, have: [0, 1, 2], complete: true, uploadedEpoch: null,
    });
    expect(await files.ids()).toEqual([f.attachment.id]);
    expect(await files.getChunk(f.attachment.id, 1)).toBe(f.blobs[1]);
  });

  it("tracks chunks put one by one and forgets a deleted file", async () => {
    const files = new MemoryLocalFileStore();
    await files.putChunk("x", 1, 2, "B");
    expect(await files.state("x")).toEqual({ id: "x", chunks: 2, have: [1], complete: false, uploadedEpoch: null });
    await files.putChunk("x", 0, 2, "A");
    expect((await files.state("x"))!.have).toEqual([0, 1]);
    await files.markComplete("x");
    await files.markUploaded("x", "E");
    expect(await files.state("x")).toEqual({ id: "x", chunks: 2, have: [0, 1], complete: true, uploadedEpoch: "E" });
    await files.delete("x");
    expect(await files.state("x")).toBeUndefined();
    expect(await files.getChunk("x", 0)).toBeUndefined();
    expect(await files.ids()).toEqual([]);
  });
});

describe("usedAttachments", () => {
  it("collects attachments of live entries only", async () => {
    const a = (await encryptFile(sample(5), { name: "a", mime: "" })).attachment;
    const b = (await encryptFile(sample(5), { name: "b", mime: "" })).attachment;
    const vault = vaultWith(newEpoch(), [a]);
    const clock = new HlcClock("dev");
    upsertEntryV2(vault, clock, "e2", { ...emptyLogin("x"), attachments: [b] });
    vault.entries.set("e2", { ...vault.entries.get("e2")!, revision: 1 });
    deleteEntryV2(vault, clock, "e2");
    expect([...usedAttachments(vault).entries()]).toEqual([[a.id, a]]);
  });
});

describe("syncFiles", () => {
  it("uploads a new file once", async () => {
    const p = phone();
    const f = await threeChunks();
    const files = new MemoryLocalFileStore();
    await storeEncryptedFile(files, f);
    const vault = vaultWith(p.epoch, [f.attachment]);
    const a = p.plugin("a");
    expect(await syncFiles(vault, files, a.send)).toEqual({ uploaded: 1, downloaded: 0, pending: 0, corrupted: [] });
    expect(p.files!.have(f.attachment.id)).toEqual([0, 1, 2]);
    expect(p.files!.get(f.attachment.id, 2)).toBe(f.blobs[2]);
    expect((await files.state(f.attachment.id))!.uploadedEpoch).toBe(p.epoch);
    expect(a.count("put")).toBe(3);

    expect(await syncFiles(vault, files, a.send)).toEqual({ uploaded: 0, downloaded: 0, pending: 0, corrupted: [] });
    expect(a.count("put")).toBe(3);
  });

  it("downloads the file on another plugin and reports progress", async () => {
    const p = phone();
    const bytes = sample(FILE_CHUNK_SIZE + 3, 11);
    const f = await encryptFile(bytes, { name: "photo.jpg", mime: "image/jpeg" });
    await uploadedFrom(p, f);

    const files = new MemoryLocalFileStore();
    const vault = vaultWith(p.epoch, [f.attachment]);
    const progress: [number, number][] = [];
    const b = p.plugin("b");
    expect(await syncFiles(vault, files, b.send, (done, total) => progress.push([done, total]))).toEqual({
      uploaded: 0, downloaded: 1, pending: 0, corrupted: [],
    });
    expect(progress).toEqual([[1, 1]]);
    expect(await decryptFile(f.attachment, await localBlobs(files, f.attachment))).toEqual(bytes);
    expect(await files.state(f.attachment.id)).toMatchObject({ complete: true, have: [0, 1] });
    expect(b.count("put")).toBe(0);

    // Nothing left to do.
    expect(await syncFiles(vault, files, b.send)).toEqual({ uploaded: 0, downloaded: 0, pending: 0, corrupted: [] });
    expect(b.count("get")).toBe(2);
    expect(b.count("put")).toBe(0);
  });

  it("resumes an interrupted upload with the missing chunks only", async () => {
    const p = phone();
    const f = await threeChunks();
    const files = new MemoryLocalFileStore();
    await storeEncryptedFile(files, f);
    const vault = vaultWith(p.epoch, [f.attachment]);
    const a = p.plugin("a");
    await expect(syncFiles(vault, files, failingAt(a.send, "put", 3))).rejects.toThrow("network down");
    expect(p.files!.have(f.attachment.id)).toEqual([0, 1]);
    expect((await files.state(f.attachment.id))!.uploadedEpoch).toBeNull();

    const before = a.count("put");
    expect(await syncFiles(vault, files, a.send)).toMatchObject({ uploaded: 1 });
    expect(a.count("put") - before).toBe(1);
    expect(a.ops.filter((r) => r.op === "put").at(-1)).toMatchObject({ index: 2 });
    expect(p.files!.have(f.attachment.id)).toEqual([0, 1, 2]);
  });

  it("resumes an interrupted download with the missing chunks only", async () => {
    const p = phone();
    const f = await threeChunks();
    await uploadedFrom(p, f);

    const files = new MemoryLocalFileStore();
    const vault = vaultWith(p.epoch, [f.attachment]);
    const b = p.plugin("b");
    await expect(syncFiles(vault, files, failingAt(b.send, "get", 2))).rejects.toThrow("network down");
    expect(await files.state(f.attachment.id)).toMatchObject({ have: [0], complete: false });

    const before = b.count("get");
    expect(await syncFiles(vault, files, b.send)).toMatchObject({ downloaded: 1 });
    expect(b.count("get") - before).toBe(2);
    expect(b.ops.filter((r) => r.op === "get").slice(-2)).toMatchObject([{ index: 1 }, { index: 2 }]);
    expect(await decryptFile(f.attachment, await localBlobs(files, f.attachment))).toEqual(sample(FILE_CHUNK_SIZE * 2 + 10));
  });

  it("leaves a file the phone does not have complete for later", async () => {
    const p = phone();
    const f = await encryptFile(sample(FILE_CHUNK_SIZE + 1), { name: "half.bin", mime: "" });
    p.files!.put(f.attachment.id, 0, 2, f.blobs[0]!, 0);
    const files = new MemoryLocalFileStore();
    const b = p.plugin("b");
    const progress: number[] = [];
    expect(await syncFiles(vaultWith(p.epoch, [f.attachment]), files, b.send, (d) => progress.push(d))).toEqual({
      uploaded: 0, downloaded: 0, pending: 1, corrupted: [],
    });
    expect(b.count("get")).toBe(0);
    expect(progress).toEqual([]);
    expect(await files.state(f.attachment.id)).toBeUndefined();
  });

  it("reports and drops a file whose content does not match its descriptor", async () => {
    const p = phone();
    const f = await threeChunks();
    f.blobs.forEach((blob, i) => p.files!.put(f.attachment.id, i, 3, blob, 0));
    const bad = { ...f.attachment, sha256: "0".repeat(64) };
    const files = new MemoryLocalFileStore();
    expect(await syncFiles(vaultWith(p.epoch, [bad]), files, p.plugin("b").send)).toEqual({
      uploaded: 0, downloaded: 0, pending: 0, corrupted: ["scan.pdf"],
    });
    expect(await files.state(f.attachment.id)).toBeUndefined();
    expect(await files.getChunk(f.attachment.id, 0)).toBeUndefined();
  });

  it("uploads again after the vault moved to a new epoch", async () => {
    const first = phone();
    const f = await threeChunks();
    const { files, vault } = await uploadedFrom(first, f);

    const second = phone();
    applyVaultInfo(vault, { epoch: second.epoch, addresses: [] });
    const a = second.plugin("a");
    expect(await syncFiles(vault, files, a.send)).toMatchObject({ uploaded: 1 });
    expect(a.count("put")).toBe(3);
    expect(second.files!.have(f.attachment.id)).toEqual([0, 1, 2]);
    expect((await files.state(f.attachment.id))!.uploadedEpoch).toBe(second.epoch);
  });

  it("throws when the phone answers with another epoch", async () => {
    const p = phone();
    const f = await threeChunks();
    const files = new MemoryLocalFileStore();
    await storeEncryptedFile(files, f);
    await expect(syncFiles(vaultWith(newEpoch(), [f.attachment]), files, p.plugin("a").send)).rejects.toThrow(
      FILE_SYNC_EPOCH_MISMATCH,
    );
    expect(FILE_SYNC_EPOCH_MISMATCH).toBe("Epoch changed, sync again");
    expect(p.files!.ids()).toEqual([]);
  });

  it("asks for a phone update when the host does not serve files", async () => {
    const p = phone({ files: null });
    const f = await threeChunks();
    const files = new MemoryLocalFileStore();
    await storeEncryptedFile(files, f);
    await expect(syncFiles(vaultWith(p.epoch, [f.attachment]), files, p.plugin("a").send)).rejects.toThrow(
      PHONE_UPDATE_REQUIRED,
    );
  });

  it("sends no request when no live entry has files", async () => {
    const p = phone();
    const a = p.plugin("a");
    expect(await syncFiles(vaultWith(p.epoch, []), new MemoryLocalFileStore(), a.send)).toEqual({
      uploaded: 0, downloaded: 0, pending: 0, corrupted: [],
    });
    expect(a.ops).toEqual([]);
  });
});

describe("noiseFileTransport", () => {
  it("returns null for a missing chunk and throws other host errors", async () => {
    const p = phone();
    const a = p.plugin("a");
    const id = crypto.randomUUID();
    expect(await a.send({ op: "get", epoch: p.epoch, id, index: 0 })).toBeNull();
    expect(await a.send({ op: "status", epoch: p.epoch, ids: [id] })).toEqual({
      files: [{ id, chunks: 0, have: [], complete: false }],
    });
    await expect(a.send({ op: "put", epoch: p.epoch, id: "nope", index: 0, chunks: 1, blob: "A" })).rejects.toThrow(
      "P2P host returned 400: malformed file request",
    );
  });
});

describe("pruneLocalFiles", () => {
  it("removes files no live entry uses", async () => {
    const used = await encryptFile(sample(10), { name: "used", mime: "" });
    const orphan = await encryptFile(sample(10), { name: "orphan", mime: "" });
    const files = new MemoryLocalFileStore();
    await storeEncryptedFile(files, used);
    await storeEncryptedFile(files, orphan);
    expect(await pruneLocalFiles(vaultWith(newEpoch(), [used.attachment]), files)).toBe(1);
    expect(await files.ids()).toEqual([used.attachment.id]);
    expect(await files.getChunk(orphan.attachment.id, 0)).toBeUndefined();
  });
});
