import { files, MemorySyncStore, p2p, randomBytes, toBase64 } from "@passholder/core";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IdbFileStore } from "../src/files/idb-file-store.ts";

// The store builds key ranges with the global IDBKeyRange, which Node lacks.
globalThis.IDBKeyRange = IDBKeyRange;

const sample = (length: number, seed = 7) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);
const newStore = () => new IdbFileStore(new IDBFactory());
const threeChunks = () =>
  files.encryptFile(sample(files.FILE_CHUNK_SIZE * 2 + 10), {
    name: "scan.pdf",
    mime: "application/pdf",
  });

describe("IdbFileStore", () => {
  it("stores a complete, not yet uploaded file", async () => {
    const f = await threeChunks();
    const store = newStore();
    await files.storeEncryptedFile(store, f);
    expect(await store.state(f.attachment.id)).toEqual({
      id: f.attachment.id,
      chunks: 3,
      have: [0, 1, 2],
      complete: true,
      uploadedEpoch: null,
    });
    expect(await store.ids()).toEqual([f.attachment.id]);
    expect(await store.getChunk(f.attachment.id, 1)).toBe(f.blobs[1]);
    expect(await store.getChunk(f.attachment.id, 7)).toBeUndefined();
  });

  it("tracks chunks put one by one and forgets a deleted file", async () => {
    const store = newStore();
    await store.putChunk("x", 1, 2, "B");
    expect(await store.state("x")).toEqual({
      id: "x",
      chunks: 2,
      have: [1],
      complete: false,
      uploadedEpoch: null,
    });
    await store.putChunk("x", 0, 2, "A");
    expect((await store.state("x"))!.have).toEqual([0, 1]);
    await store.markComplete("x");
    await store.markUploaded("x", "E");
    expect(await store.state("x")).toEqual({
      id: "x",
      chunks: 2,
      have: [0, 1],
      complete: true,
      uploadedEpoch: "E",
    });
    await store.markIncomplete("x", [1]);
    expect(await store.state("x")).toEqual({
      id: "x",
      chunks: 2,
      have: [1],
      complete: false,
      uploadedEpoch: "E",
    });
    await store.delete("x");
    expect(await store.state("x")).toBeUndefined();
    expect(await store.getChunk("x", 0)).toBeUndefined();
    expect(await store.ids()).toEqual([]);
  });

  it("starts a file over when it is announced with another chunk count", async () => {
    const store = newStore();
    await store.putChunk("x", 0, 2, "A");
    await store.putChunk("x", 1, 2, "B");
    await store.markComplete("x");
    await store.markUploaded("x", "E");
    await store.putChunk("x", 0, 3, "C");
    expect(await store.state("x")).toEqual({
      id: "x",
      chunks: 3,
      have: [0],
      complete: false,
      uploadedEpoch: null,
    });
    expect(await store.getChunk("x", 0)).toBe("C");
    expect(await store.getChunk("x", 1)).toBeUndefined();
  });

  it("returns a state the caller may change, and ignores marks on unknown files", async () => {
    const store = newStore();
    await store.putChunk("x", 0, 1, "A");
    (await store.state("x"))!.have.push(9);
    expect((await store.state("x"))!.have).toEqual([0]);
    await store.markComplete("nope");
    await store.markIncomplete("nope", []);
    await store.markUploaded("nope", "E");
    expect(await store.ids()).toEqual(["x"]);
    expect(await store.state("nope")).toBeUndefined();
  });

  it("does not mix chunks of files whose ids share a prefix", async () => {
    const store = newStore();
    await store.putChunk("a", 0, 1, "A");
    await store.putChunk("a1", 0, 1, "A1");
    await store.delete("a");
    expect(await store.getChunk("a1", 0)).toBe("A1");
    expect((await store.state("a1"))!.have).toEqual([0]);
  });

  it("a database that does not open fails each operation, without an unhandled rejection", async () => {
    const failing = {
      open: () => {
        const request = {} as { error?: Error; onerror?: () => void };
        setTimeout(() => {
          request.error = new Error("blocked");
          request.onerror?.();
        }, 0);
        return request;
      },
    } as unknown as IDBFactory;
    const store = new IdbFileStore(failing);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(store.ids()).rejects.toThrow("blocked");
    await expect(store.state("x")).rejects.toThrow("blocked");
  });

  it("keeps data across instances on the same database", async () => {
    const factory = new IDBFactory();
    const first = new IdbFileStore(factory);
    await first.putChunk("x", 0, 2, "A");
    await first.markUploaded("x", "E");
    const second = new IdbFileStore(factory);
    expect(await second.state("x")).toEqual({
      id: "x",
      chunks: 2,
      have: [0],
      complete: false,
      uploadedEpoch: "E",
    });
    expect(await second.getChunk("x", 0)).toBe("A");
    expect(await new IdbFileStore(factory, "other").ids()).toEqual([]);
  });

  it("syncs end to end with a phone host: upload, then download on another store", async () => {
    const epoch = toBase64(randomBytes(16));
    const phoneFiles = new files.MemoryFileStore();
    const hostKey = p2p.generateKeyPair();
    const devices: p2p.PairedDevice[] = [];
    const host = new p2p.P2pHost({
      staticKey: hostKey,
      devices: () => devices,
      store: new MemorySyncStore(),
      epoch,
      addresses: () => [],
      files: phoneFiles,
    });
    const post: p2p.FetchJson = async (url, body) =>
      structuredClone(await host.handle(new URL(url).pathname, structuredClone(body)));
    const plugin = (deviceId: string) => {
      const key = p2p.generateKeyPair();
      devices.push({ deviceId, name: deviceId, staticPublicKey: key.publicKey });
      return files.noiseFileTransport({
        baseUrl: "http://phone/",
        deviceId,
        staticKey: key,
        peerPublicKey: hostKey.publicKey,
        post,
      });
    };

    const f = await threeChunks();
    const vault = p2p.emptyVault();
    p2p.applyVaultInfo(vault, { epoch, addresses: [] });
    p2p.upsertEntry(vault, new p2p.HlcClock("dev"), "e1", {
      ...p2p.emptyLogin("e"),
      attachments: [f.attachment],
    });

    const a = newStore();
    await files.storeEncryptedFile(a, f);
    expect(await files.syncFiles(vault, a, plugin("a"))).toEqual({
      uploaded: 1,
      downloaded: 0,
      pending: 0,
      corrupted: [],
    });
    expect(phoneFiles.have(f.attachment.id)).toEqual([0, 1, 2]);
    expect((await a.state(f.attachment.id))!.uploadedEpoch).toBe(epoch);

    const b = newStore();
    const progress: [number, number][] = [];
    expect(
      await files.syncFiles(vault, b, plugin("b"), { onProgress: (d, t) => progress.push([d, t]) }),
    ).toEqual({
      uploaded: 0,
      downloaded: 1,
      pending: 0,
      corrupted: [],
    });
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
    const blobs = await Promise.all([0, 1, 2].map((i) => b.getChunk(f.attachment.id, i)));
    expect(await files.decryptFile(f.attachment, blobs as string[])).toEqual(
      sample(files.FILE_CHUNK_SIZE * 2 + 10),
    );
    expect(await b.state(f.attachment.id)).toMatchObject({ complete: true, have: [0, 1, 2] });
  });
});
