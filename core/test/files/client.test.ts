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
  P2pHostError,
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
    await files.markIncomplete("x", [1]);
    expect(await files.state("x")).toEqual({ id: "x", chunks: 2, have: [1], complete: false, uploadedEpoch: "E" });
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

  it("skips ids in skip", async () => {
    const p = phone();
    const f = await encryptFile(sample(FILE_CHUNK_SIZE + 3, 11), { name: "photo.jpg", mime: "image/jpeg" });
    await uploadedFrom(p, f);

    const b = p.plugin("b");
    const vault = vaultWith(p.epoch, [f.attachment]);
    expect(await syncFiles(vault, new MemoryLocalFileStore(), b.send, undefined, new Set([f.attachment.id]))).toEqual({
      uploaded: 0, downloaded: 0, pending: 0, corrupted: [],
    });
    expect(b.ops).toEqual([]);
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

describe("syncFiles: what gets asked", () => {
  it("sends no request at all once everything is synced", async () => {
    const p = phone();
    const f = await threeChunks();
    const { files, vault } = await uploadedFrom(p, f);
    const a = p.plugin("a2");
    expect(await syncFiles(vault, files, a.send)).toEqual({ uploaded: 0, downloaded: 0, pending: 0, corrupted: [] });
    expect(a.ops).toEqual([]);

    const bFiles = new MemoryLocalFileStore();
    const bVault = vaultWith(p.epoch, [f.attachment]);
    const b = p.plugin("b");
    await syncFiles(bVault, bFiles, b.send);
    const sent = b.ops.length;
    expect(await syncFiles(bVault, bFiles, b.send)).toEqual({ uploaded: 0, downloaded: 0, pending: 0, corrupted: [] });
    expect(b.ops.length).toBe(sent);
  });

  it("asks for status in batches of 500 ids", async () => {
    const p = phone();
    const base = (await encryptFile(sample(5), { name: "x", mime: "" })).attachment;
    const vault = emptyVaultV2();
    applyVaultInfo(vault, { epoch: p.epoch, addresses: [] });
    const clock = new HlcClock("dev");
    const ids: string[] = [];
    for (let e = 0; e < 13; e++) {
      const attachments = Array.from({ length: e < 12 ? 40 : 21 }, () => {
        const id = crypto.randomUUID();
        ids.push(id);
        return { ...base, id };
      });
      upsertEntryV2(vault, clock, `e${e}`, { ...emptyLogin(`n${e}`), attachments });
    }
    expect(ids).toHaveLength(501);
    const a = p.plugin("a");
    expect(await syncFiles(vault, new MemoryLocalFileStore(), a.send)).toMatchObject({ pending: 501 });
    const status = a.ops.filter((r): r is Extract<P2pFileRequest, { op: "status" }> => r.op === "status");
    expect(status.map((r) => r.ids.length)).toEqual([500, 1]);
    expect(status.flatMap((r) => r.ids)).toEqual(ids);
  });
});

describe("syncFiles: files the phone refuses", () => {
  it("counts a 400 or 409 on one file as pending and uploads the others", async () => {
    const p = phone();
    const mismatch = await encryptFile(sample(20, 1), { name: "m.txt", mime: "text/plain" });
    const differs = await encryptFile(sample(20, 2), { name: "d.txt", mime: "text/plain" });
    const good = await encryptFile(sample(20, 3), { name: "g.txt", mime: "text/plain" });
    const files = new MemoryLocalFileStore();
    for (const f of [mismatch, differs, good]) await storeEncryptedFile(files, f);
    // The phone holds only chunk 1 of a 2-chunk file under this id: our 1-chunk put gets 400 "chunk count mismatch".
    p.files!.put(mismatch.attachment.id, 1, 2, "AAAA", 0);
    const vault = vaultWith(p.epoch, [mismatch.attachment, differs.attachment, good.attachment]);
    const a = p.plugin("a");
    // A stale status can lead to 409 "chunk differs"; simulate it for the second file.
    const send: P2pFileTransport = (r) =>
      r.op === "put" && r.id === differs.attachment.id ? Promise.reject(new P2pHostError(409, "chunk differs")) : a.send(r);
    expect(await syncFiles(vault, files, send)).toEqual({ uploaded: 1, downloaded: 0, pending: 2, corrupted: [] });
    expect(p.files!.have(good.attachment.id)).toEqual([0]);
    expect((await files.state(good.attachment.id))!.uploadedEpoch).toBe(p.epoch);
    expect((await files.state(mismatch.attachment.id))!.uploadedEpoch).toBeNull();
  });

  it("still throws other host errors", async () => {
    const p = phone();
    const f = await encryptFile(sample(20), { name: "a.txt", mime: "text/plain" });
    const files = new MemoryLocalFileStore();
    await storeEncryptedFile(files, f);
    const vault = vaultWith(p.epoch, [f.attachment]);
    const a = p.plugin("a");
    const send: P2pFileTransport = (r) => (r.op === "put" ? Promise.reject(new P2pHostError(507, "insufficient storage")) : a.send(r));
    await expect(syncFiles(vault, files, send)).rejects.toThrow("507");
  });
});

describe("syncFiles: damaged files", () => {
  /** A store that has lost some chunks without noticing (state still says complete). */
  class LossyStore extends MemoryLocalFileStore {
    lost = new Set<string>();
    override async getChunk(id: string, index: number) {
      return this.lost.has(`${id}/${index}`) ? undefined : super.getChunk(id, index);
    }
  }

  it("marks a local file with a lost chunk incomplete and goes on with the others", async () => {
    const p = phone();
    const broken = await threeChunks();
    const good = await encryptFile(sample(20), { name: "good.txt", mime: "text/plain" });
    const files = new LossyStore();
    await storeEncryptedFile(files, broken);
    await storeEncryptedFile(files, good);
    files.lost.add(`${broken.attachment.id}/1`);
    const vault = vaultWith(p.epoch, [broken.attachment, good.attachment]);
    const progress: [number, number][] = [];
    expect(await syncFiles(vault, files, p.plugin("a").send, (d, t) => progress.push([d, t]))).toEqual({
      uploaded: 1, downloaded: 0, pending: 1, corrupted: [],
    });
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(await files.state(broken.attachment.id)).toMatchObject({ complete: false, have: [0, 2], uploadedEpoch: null });
    expect(p.files!.have(good.attachment.id)).toEqual([0]);
  });

  it("treats a phone file with another chunk count as corrupted", async () => {
    const p = phone();
    const f = await encryptFile(sample(FILE_CHUNK_SIZE + 1), { name: "odd.bin", mime: "" });
    // The phone holds a complete one-chunk file under the id of a two-chunk descriptor.
    p.files!.put(f.attachment.id, 0, 1, f.blobs[0]!, 0);
    const files = new MemoryLocalFileStore();
    const b = p.plugin("b");
    expect(await syncFiles(vaultWith(p.epoch, [f.attachment]), files, b.send)).toEqual({
      uploaded: 0, downloaded: 0, pending: 0, corrupted: ["odd.bin"],
    });
    expect(b.count("get")).toBe(1);
    expect(await files.state(f.attachment.id)).toBeUndefined();
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
