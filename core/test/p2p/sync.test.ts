import { describe, expect, it } from "vitest";
import { seal } from "../../src/cipher.ts";
import { randomBytes, toBase64, utf8 } from "../../src/encoding.ts";
import { newVaultKey } from "../../src/vault.ts";
import {
  applyVaultInfo,
  clockForVault,
  compareHlc,
  decryptPayloadV2,
  deleteEntryV2,
  emptyLogin,
  emptyVaultV2,
  encryptPayloadV2,
  ENTRY_TOO_LARGE_TO_SYNC,
  entryBlobLength,
  MAX_BLOB_BYTES_PER_ROUND,
  MAX_ENTRY_BLOB_LENGTH,
  validateP2pSyncRequest,
  type EntryContentV3,
  HlcClock,
  liveEntriesV2,
  MAX_CHANGES_PER_REQUEST,
  MAX_CHANGES_PER_RESPONSE,
  MAX_SYNC_ROUNDS,
  processP2pSync,
  syncVaultV2,
  upsertEntryV2,
  type LocalVaultV2,
  type P2pSyncRequest,
  type P2pSyncResponse,
  type P2pTransport,
} from "../../src/p2p/index.ts";
import { MemorySyncStore } from "../../src/protocol.ts";
import { MAX_ATTACHMENTS_PARSED, type Attachment } from "../../src/files/index.ts";

const newEpoch = () => toBase64(randomBytes(16));
const ADDRESS = "192.168.1.5:8787";
const login = (name: string, username = "u", password = "p"): EntryContentV3 => ({
  ...emptyLogin(name),
  fields: { username, password, totp: "", urls: [], androidApps: [] },
});
const entry = (name: string) => login(name);

function setup(epoch = newEpoch()) {
  const store = new MemorySyncStore();
  const vaultKey = newVaultKey();
  const transport =
    (e: string): P2pTransport =>
    async (r) =>
      structuredClone(processP2pSync(store, e, [ADDRESS], structuredClone(r)));
  const send = transport(epoch);
  const sync = (vault: LocalVaultV2, clock: HlcClock) => syncVaultV2(vault, vaultKey, clock, send);
  return { store, vaultKey, epoch, send, sync, transport };
}

const names = (v: LocalVaultV2) =>
  liveEntriesV2(v)
    .map((e) => e.data.name)
    .sort();

describe("p2p sync", () => {
  it("moves entries between two devices and learns the epoch and addresses", async () => {
    const { sync, epoch } = setup();
    const phone = emptyVaultV2();
    const ext = emptyVaultV2();
    const phoneClock = new HlcClock("phone", () => 1000);
    const extClock = new HlcClock("ext", () => 1000);

    upsertEntryV2(phone, phoneClock, "1", entry("Bank"));
    upsertEntryV2(phone, phoneClock, "2", entry("Mail"));
    await sync(phone, phoneClock);
    await sync(ext, extClock);

    expect(ext.epoch).toBe(epoch);
    expect(ext.addresses).toEqual([ADDRESS]);
    expect(names(ext)).toEqual(["Bank", "Mail"]);

    upsertEntryV2(ext, extClock, "3", entry("Shop"));
    await sync(ext, extClock);
    await sync(phone, phoneClock);
    expect(names(phone)).toEqual(["Bank", "Mail", "Shop"]);
    await sync(ext, extClock);
    expect(ext.addresses).toEqual([ADDRESS]);
  });

  it("a later edit wins even when its device clock is far behind", async () => {
    const { sync } = setup();
    const phone = emptyVaultV2();
    const ext = emptyVaultV2();
    const phoneClock = new HlcClock("phone", () => 1_000_000);
    const extClock = new HlcClock("ext", () => 10);

    upsertEntryV2(phone, phoneClock, "1", entry("Old"));
    await sync(phone, phoneClock);
    await sync(ext, extClock);
    upsertEntryV2(ext, extClock, "1", entry("New"));
    await sync(ext, extClock);
    await sync(phone, phoneClock);

    expect(names(phone)).toEqual(["New"]);
    expect(names(ext)).toEqual(["New"]);
  });

  it("ignores an older version of an entry replayed by the host under a new revision (V3-I2)", async () => {
    const { sync, store } = setup();
    const phone = emptyVaultV2();
    const ext = emptyVaultV2();
    let t = 1000;
    const phoneClock = new HlcClock("phone", () => t);
    const extClock = new HlcClock("ext", () => t);

    upsertEntryV2(phone, phoneClock, "1", entry("Old"));
    await sync(phone, phoneClock);
    const old = structuredClone(store.get("1")!);
    t = 2000;
    upsertEntryV2(phone, phoneClock, "1", entry("New"));
    await sync(phone, phoneClock);
    await sync(ext, extClock);
    expect(names(ext)).toEqual(["New"]);

    // A host that replays the old ciphertext (old password) under a fresh revision.
    store.put({ ...old, revision: store.currentRevision() + 1 });
    await sync(ext, extClock);
    expect(names(ext)).toEqual(["New"]);

    // The extension's next edit still reaches the host (conflict, won by HLC).
    t = 3000;
    upsertEntryV2(ext, extClock, "1", entry("Newest"));
    await sync(ext, extClock);
    await sync(phone, phoneClock);
    expect(names(phone)).toEqual(["Newest"]);
    expect(ext.entries.get("1")!.dirty).toBe(false);
  });

  it.each([
    ["edit then delete", "delete"],
    ["delete then edit", "edit"],
  ])("edit versus delete: %s, the later operation wins", async (_label, winner) => {
    const { sync } = setup();
    const phone = emptyVaultV2();
    const ext = emptyVaultV2();
    let t = 1000;
    const phoneClock = new HlcClock("phone", () => t);
    const extClock = new HlcClock("ext", () => t);

    upsertEntryV2(phone, phoneClock, "1", entry("Start"));
    await sync(phone, phoneClock);
    await sync(ext, extClock);

    // Both change offline; the order is decided by the clock at the time of the operation.
    if (winner === "delete") {
      t = 2000;
      upsertEntryV2(phone, phoneClock, "1", entry("Edited"));
      t = 3000;
      deleteEntryV2(ext, extClock, "1");
    } else {
      t = 2000;
      deleteEntryV2(ext, extClock, "1");
      t = 3000;
      upsertEntryV2(phone, phoneClock, "1", entry("Edited"));
    }
    await sync(ext, extClock);
    await sync(phone, phoneClock);
    await sync(ext, extClock);

    const expected = winner === "delete" ? [] : ["Edited"];
    expect(names(phone)).toEqual(expected);
    expect(names(ext)).toEqual(expected);
    expect(phone.entries.get("1")?.deleted).toBe(winner === "delete");
  });

  it("resends everything, including unsynced edits and tombstones, after the epoch changes", async () => {
    const first = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    upsertEntryV2(ext, clock, "a", entry("A"));
    upsertEntryV2(ext, clock, "b", entry("B"));
    upsertEntryV2(ext, clock, "c", entry("C"));
    await first.sync(ext, clock);
    deleteEntryV2(ext, clock, "c");
    await first.sync(ext, clock);
    expect(ext.epoch).toBe(first.epoch);
    upsertEntryV2(ext, clock, "a", entry("A edited offline"));

    const second = setup();
    second.vaultKey.set(first.vaultKey);
    await second.sync(ext, clock);

    expect(ext.epoch).toBe(second.epoch);
    expect(second.store.listSince(0)).toHaveLength(3);
    expect(second.store.get("c")?.deleted).toBe(true);
    const a = second.store.get("a")!;
    expect(await decryptPayloadV2(first.vaultKey, "a", a.blob)).toMatchObject({
      name: "A edited offline",
    });
    expect([...ext.entries.values()].every((e) => !e.dirty)).toBe(true);
    expect(names(ext)).toEqual(["A edited offline", "B"]);
  });

  it("throws when the epoch changes twice during one sync", async () => {
    const { vaultKey } = setup();
    const a = setup();
    const b = setup();
    let n = 0;
    const flipping: P2pTransport = (r) =>
      (n++ % 2 === 0 ? a : b).transport(n % 2 === 1 ? a.epoch : b.epoch)(r);
    const clock = new HlcClock("ext", () => 1);
    await expect(syncVaultV2(emptyVaultV2(), vaultKey, clock, flipping)).rejects.toThrow(
      "Epoch changed twice during sync",
    );
  });

  it("host ignores changes sent with a stale epoch", async () => {
    const { store, vaultKey, epoch } = setup();
    const request: P2pSyncRequest = {
      epoch: newEpoch(),
      sinceRevision: 0,
      changes: [
        {
          id: "1",
          baseRevision: 0,
          deleted: false,
          blob: await encryptPayloadV2(vaultKey, "1", {
            ...login("x"),
            v: 3,
            hlc: { ms: 1, c: 0, d: "d" },
          }),
        },
      ],
    };
    const response = processP2pSync(store, epoch, [ADDRESS], request);

    expect(store.currentRevision()).toBe(0);
    expect(store.get("1")).toBeUndefined();
    expect(response).toEqual({
      epoch,
      currentRevision: 0,
      accepted: [],
      conflicts: [],
      changes: [],
      addresses: [ADDRESS],
      more: false,
    });
  });

  it("payloads are bound to their id and to v2", async () => {
    const key = newVaultKey();
    const data = { ...login("x"), v: 3 as const, hlc: { ms: 1, c: 0, d: "d" } };
    const blob = await encryptPayloadV2(key, "1", data);

    expect(await decryptPayloadV2(key, "1", blob)).toEqual(data);
    await expect(decryptPayloadV2(key, "2", blob)).rejects.toThrow();
    // A v1 payload, sealed the way the removed Pi sync did it.
    const v1 = await seal(
      key,
      utf8(JSON.stringify({ name: "x", username: "u", password: "p", modifiedAt: 1 })),
      "passholder/v1/entry/1",
    );
    await expect(decryptPayloadV2(key, "1", v1)).rejects.toThrow();
  });
});

describe("p2p sync: final review fixes", () => {
  const password = async (s: ReturnType<typeof setup>, id: string) =>
    (
      (await decryptPayloadV2(s.vaultKey, id, s.store.get(id)!.blob)) as {
        fields?: { password?: string };
      }
    ).fields?.password;

  it("an edit made while its push is in flight stays dirty and reaches the phone on the next sync", async () => {
    const s = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    upsertEntryV2(ext, clock, "1", login("Bank", "u", "old"));
    let edited = false;
    await syncVaultV2(ext, s.vaultKey, clock, async (r) => {
      const res = await s.send(r);
      if (!edited && r.epoch === s.epoch && r.changes.length > 0) {
        edited = true;
        upsertEntryV2(ext, clock, "1", login("Bank", "u", "NEW"));
      }
      return res;
    });
    expect(ext.entries.get("1")?.dirty).toBe(true);
    expect(ext.entries.get("1")?.revision).toBe(1);
    await s.sync(ext, clock);
    expect(await password(s, "1")).toBe("NEW");
    expect(ext.entries.get("1")?.dirty).toBe(false);
  });

  it("deleting an entry while its first push is in flight leaves a tombstone on the phone", async () => {
    const s = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    upsertEntryV2(ext, clock, "1", entry("Bank"));
    let deleted = false;
    await syncVaultV2(ext, s.vaultKey, clock, async (r) => {
      const res = await s.send(r);
      if (!deleted && r.epoch === s.epoch && r.changes.length > 0) {
        deleted = true;
        deleteEntryV2(ext, clock, "1");
      }
      return res;
    });
    expect(ext.entries.get("1")).toMatchObject({ deleted: true, dirty: true, revision: 1 });
    await s.sync(ext, clock);
    expect(s.store.get("1")?.deleted).toBe(true);
    expect(ext.entries.get("1")).toMatchObject({ deleted: true, dirty: false });
  });

  it("a restarted clock still orders an edit after the version it overwrites", async () => {
    const first = setup();
    const phone = emptyVaultV2();
    const phoneClock = new HlcClock("phone", () => 5_000_000);
    const a = emptyVaultV2();
    upsertEntryV2(phone, phoneClock, "x", login("X", "u", "phone-v1"));
    await first.sync(phone, phoneClock);
    await first.sync(a, new HlcClock("a", () => 1000));

    const restarted = new HlcClock("a", () => 2000);
    upsertEntryV2(a, restarted, "x", login("X", "u", "a-edit"));
    const hlc = a.entries.get("x")!.data.hlc;
    expect(hlc.ms).toBeGreaterThanOrEqual(5_000_000);

    // The phone loses its state: both devices upload again into a new epoch.
    const second = setup();
    second.vaultKey.set(first.vaultKey);
    await second.sync(phone, phoneClock);
    await second.sync(a, restarted);
    expect(await password(second, "x")).toBe("a-edit");
  });

  it("deleteEntryV2 also observes the overwritten HLC", () => {
    const v = emptyVaultV2();
    upsertEntryV2(v, new HlcClock("phone", () => 5_000_000), "x", entry("X"));
    v.entries.set("x", { ...v.entries.get("x")!, revision: 3, dirty: false });
    deleteEntryV2(v, new HlcClock("a", () => 2000), "x");
    expect(v.entries.get("x")!.data.hlc.ms).toBe(5_000_000);
  });

  it("clockForVault seeds the clock with the largest HLC in the vault", () => {
    const v = emptyVaultV2();
    upsertEntryV2(v, new HlcClock("p", () => 7_000), "a", entry("A"));
    upsertEntryV2(v, new HlcClock("q", () => 9_000), "b", entry("B"));
    upsertEntryV2(v, new HlcClock("r", () => 8_000), "c", entry("C"));
    const clock = clockForVault(v, "me", () => 10);
    expect(clock.tick()).toEqual({ ms: 9_000, c: 1, d: "me" });
    expect(clockForVault(emptyVaultV2(), "me", () => 10).tick()).toEqual({ ms: 10, c: 0, d: "me" });
  });

  it("applyVaultInfo with a new epoch resets the vault and replaces the addresses", async () => {
    const first = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    applyVaultInfo(ext, { epoch: first.epoch, addresses: ["10.0.0.1:1"] });
    expect(ext.epoch).toBe(first.epoch);
    expect(ext.addresses).toEqual(["10.0.0.1:1"]);
    upsertEntryV2(ext, clock, "a", entry("A"));
    upsertEntryV2(ext, clock, "b", entry("B"));
    await first.sync(ext, clock);
    expect(ext.addresses).toEqual(["10.0.0.1:1", ADDRESS]);

    const second = setup();
    second.vaultKey.set(first.vaultKey);
    applyVaultInfo(ext, { epoch: second.epoch, addresses: ["10.0.0.2:2"] });
    expect(ext.epoch).toBe(second.epoch);
    expect(ext.lastSyncRevision).toBe(0);
    expect(ext.addresses).toEqual(["10.0.0.2:2"]);
    expect([...ext.entries.values()].every((e) => e.dirty && e.revision === 0)).toBe(true);
    await second.sync(ext, clock);
    expect(
      second.store
        .listSince(0)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b"]);

    // Same epoch: only the addresses change.
    applyVaultInfo(ext, { epoch: second.epoch, addresses: ["10.0.0.3:3"] });
    expect(ext.addresses).toEqual(["10.0.0.3:3"]);
    expect([...ext.entries.values()].every((e) => !e.dirty && e.revision > 0)).toBe(true);
  });

  it("an epoch change during sync replaces the addresses", async () => {
    const first = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    await first.sync(ext, clock);
    ext.addresses.push("stale:1");
    const second = setup();
    await syncVaultV2(ext, second.vaultKey, clock, async (r) =>
      structuredClone(processP2pSync(second.store, second.epoch, ["new:2"], structuredClone(r))),
    );
    expect(ext.addresses).toEqual(["new:2"]);
  });

  it("re-uploads everything when the phone's revision went backwards in the same epoch", async () => {
    const s = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    for (const id of ["a", "b", "c"]) upsertEntryV2(ext, clock, id, entry(id));
    await s.sync(ext, clock);
    expect(ext.lastSyncRevision).toBe(3);

    // Same epoch, but the phone's store was restored from an older (here: empty) state.
    const restored = new MemorySyncStore();
    await syncVaultV2(ext, s.vaultKey, clock, async (r) =>
      structuredClone(processP2pSync(restored, s.epoch, [ADDRESS], structuredClone(r))),
    );
    expect(
      restored
        .listSince(0)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(ext.lastSyncRevision).toBe(3);
  });
});

describe("p2p sync: paging", () => {
  it("host returns at most MAX_CHANGES_PER_RESPONSE records and continues from the last one", async () => {
    const s = setup();
    for (let i = 1; i <= 1300; i++)
      s.store.put({ id: `id${i}`, revision: i, deleted: false, blob: "x" });
    const page = (since: number) =>
      processP2pSync(s.store, s.epoch, [], { epoch: s.epoch, sinceRevision: since, changes: [] });
    const first = page(0);
    expect(first.changes).toHaveLength(MAX_CHANGES_PER_RESPONSE);
    expect(first.more).toBe(true);
    expect(first.currentRevision).toBe(500);
    expect(first.changes.map((c) => c.revision)).toEqual(
      Array.from({ length: 500 }, (_, i) => i + 1),
    );
    expect(page(500)).toMatchObject({ more: true, currentRevision: 1000 });
    const last = page(1000);
    expect(last).toMatchObject({ more: false, currentRevision: 1300 });
    expect(last.changes).toHaveLength(300);
    expect(
      processP2pSync(s.store, s.epoch, [], { epoch: "", sinceRevision: 0, changes: [] }).more,
    ).toBe(false);
  });

  it("host rejects more than MAX_CHANGES_PER_REQUEST changes", () => {
    const s = setup();
    const changes = Array.from({ length: MAX_CHANGES_PER_REQUEST + 1 }, (_, i) => ({
      id: `${i}`,
      baseRevision: 0,
      deleted: false,
      blob: "x",
    }));
    expect(() =>
      processP2pSync(s.store, s.epoch, [], { epoch: s.epoch, sinceRevision: 0, changes }),
    ).toThrow("too many changes");
    expect(s.store.currentRevision()).toBe(0);
  });

  it("uploads 1300 dirty entries after an epoch reset in requests of at most 500 changes", async () => {
    const first = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    for (let i = 0; i < 1300; i++) upsertEntryV2(ext, clock, `id${i}`, entry(`n${i}`));
    await first.sync(ext, clock);
    expect(first.store.currentRevision()).toBe(1300);

    const second = setup();
    second.vaultKey.set(first.vaultKey);
    const sizes: number[] = [];
    await syncVaultV2(ext, second.vaultKey, clock, async (r) => {
      sizes.push(r.changes.length);
      return second.send(r);
    });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_CHANGES_PER_REQUEST);
    expect(second.store.listSince(0)).toHaveLength(1300);
    expect([...ext.entries.values()].every((e) => !e.dirty)).toBe(true);
    expect(ext.lastSyncRevision).toBe(1300);
  });

  it("throws after the safety limit of rounds when the host never finishes paging", async () => {
    const s = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    await s.sync(ext, clock);
    let calls = 0;
    const endless: P2pTransport = async () => {
      calls++;
      return {
        epoch: s.epoch,
        currentRevision: 0,
        accepted: [],
        conflicts: [],
        changes: [],
        addresses: [],
        more: true,
      };
    };
    await expect(syncVaultV2(ext, s.vaultKey, clock, endless)).rejects.toThrow("Sync exceeded");
    expect(calls).toBe(MAX_SYNC_ROUNDS);
  });
});

describe("p2p sync: v3 entries and byte budget", () => {
  const big = (name: string, kib = 44) => login(name, "u", "p".repeat(kib * 1024));
  const blobSum = (xs: { blob: string }[]) => xs.reduce((n, x) => n + x.blob.length, 0);

  it("pages request by bytes", async () => {
    const s = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    for (let i = 0; i < 20; i++) upsertEntryV2(ext, clock, `id${i}`, big(`n${i}`));
    const requests: P2pSyncRequest[] = [];
    await syncVaultV2(ext, s.vaultKey, clock, async (r) => {
      requests.push(structuredClone(r));
      return s.send(r);
    });
    expect(requests.length).toBeGreaterThan(1);
    for (const r of requests)
      expect(blobSum(r.changes)).toBeLessThanOrEqual(MAX_BLOB_BYTES_PER_ROUND);
    expect(s.store.listSince(0)).toHaveLength(20);
    expect([...ext.entries.values()].every((e) => !e.dirty)).toBe(true);
  });

  it("pages response by bytes", async () => {
    const s = setup();
    const phone = emptyVaultV2();
    const pc = new HlcClock("phone", () => 1000);
    for (let i = 0; i < 20; i++) upsertEntryV2(phone, pc, `id${i}`, big(`n${i}`));
    await s.sync(phone, pc);
    const ext = emptyVaultV2();
    const responses: P2pSyncResponse[] = [];
    await syncVaultV2(ext, s.vaultKey, new HlcClock("ext", () => 1000), async (r) => {
      const res = await s.send(r);
      responses.push(res);
      return res;
    });
    const real = responses.filter((r) => r.epoch === s.epoch && (r.changes.length > 0 || r.more));
    for (const r of real)
      expect(blobSum([...r.conflicts, ...r.changes])).toBeLessThanOrEqual(MAX_BLOB_BYTES_PER_ROUND);
    expect(real.slice(0, -1).every((r) => r.more)).toBe(true);
    expect(real.at(-1)!.more).toBe(false);
    expect(real.length).toBeGreaterThan(1);
    expect(liveEntriesV2(ext)).toHaveLength(20);
  });

  it("truncated conflicts settle", async () => {
    const s = setup();
    const phone = emptyVaultV2();
    const ext = emptyVaultV2();
    const pc = new HlcClock("phone", () => 5000);
    for (let i = 0; i < 20; i++) upsertEntryV2(phone, pc, `id${i}`, login(`n${i}`));
    await s.sync(phone, pc);
    await s.sync(ext, new HlcClock("ext", () => 1000));
    // The phone writes big newer versions; the ext edits every entry on a stale base with a later HLC, so it wins.
    for (let i = 0; i < 20; i++) upsertEntryV2(phone, pc, `id${i}`, big(`p${i}`));
    await s.sync(phone, pc);
    const extClock = new HlcClock("ext", () => 9_000_000);
    for (let i = 0; i < 20; i++) upsertEntryV2(ext, extClock, `id${i}`, login(`e${i}`));
    const responses: P2pSyncResponse[] = [];
    await syncVaultV2(ext, s.vaultKey, extClock, async (r) => {
      const res = await s.send(r);
      responses.push(res);
      return res;
    });
    // Conflicts really were cut by the byte budget along the way.
    expect(responses.some((r) => r.more && r.conflicts.length > 0)).toBe(true);
    const expected = Array.from({ length: 20 }, (_, i) => `e${i}`).sort();
    expect(names(ext)).toEqual(expected);
    expect([...ext.entries.values()].every((e) => !e.dirty)).toBe(true);
    const fresh = emptyVaultV2();
    await s.sync(fresh, new HlcClock("fresh", () => 1000));
    expect(names(fresh)).toEqual(expected);
  });

  it("host rejects blob over 64 KiB", () => {
    const s = setup();
    const request = (len: number, epoch = s.epoch) => ({
      epoch,
      sinceRevision: 0,
      changes: [{ id: "1", baseRevision: 0, deleted: false, blob: "x".repeat(len) }],
    });
    expect(validateP2pSyncRequest(s.store, s.epoch, request(MAX_ENTRY_BLOB_LENGTH + 1))).toBe(
      "blob too large",
    );
    expect(
      validateP2pSyncRequest(s.store, s.epoch, request(MAX_ENTRY_BLOB_LENGTH + 1, "other")),
    ).toBe("blob too large");
    expect(
      validateP2pSyncRequest(s.store, s.epoch, request(MAX_ENTRY_BLOB_LENGTH)),
    ).toBeUndefined();
  });

  it("upsert rejects too large entry", () => {
    const v = emptyVaultV2();
    const clock = new HlcClock("a", () => 1000);
    upsertEntryV2(v, clock, "ok", entry("ok"));
    const before = structuredClone([...v.entries]);
    const note = { ...emptyLogin("big"), note: "a".repeat(70_000) };
    expect(() => upsertEntryV2(v, clock, "big", note)).toThrow("Entry too large");
    // Overwriting an existing entry must not change it either.
    expect(() => upsertEntryV2(v, clock, "ok", note)).toThrow("Entry too large");
    expect([...v.entries]).toEqual(before);
    expect(entryBlobLength({ ...note, v: 3, hlc: { ms: 1, c: 0, d: "a" } })).toBeGreaterThan(
      MAX_ENTRY_BLOB_LENGTH,
    );
  });

  it("throws a clear error, before sending, for a dirty entry too large to sync", async () => {
    const s = setup();
    const v = emptyVaultV2();
    const clock = new HlcClock("a", () => 1000);
    upsertEntryV2(v, clock, "ok", entry("ok"));
    // Saved before v3 and near the limit: it no longer fits once serialized as v3.
    const huge = { ...emptyLogin("Huge"), note: "a".repeat(70_000) };
    v.entries.set("huge", {
      id: "huge",
      revision: 0,
      dirty: true,
      deleted: false,
      data: { ...huge, v: 3, hlc: { ms: 1, c: 0, d: "a" } },
    });
    const requests: P2pSyncRequest[] = [];
    await expect(
      syncVaultV2(v, s.vaultKey, clock, async (r) => {
        requests.push(r);
        return s.send(r);
      }),
    ).rejects.toThrow(`${ENTRY_TOO_LARGE_TO_SYNC}: Huge`);
    expect(requests).toHaveLength(0);
  });

  it("remote v2 payload is read as login", async () => {
    const s = setup();
    const legacy = { name: "Old", username: "u", password: "p", hlc: { ms: 1, c: 0, d: "d" } };
    const blob = await seal(s.vaultKey, utf8(JSON.stringify(legacy)), "passholder/v2/entry/1");
    s.store.put({ id: "1", revision: 1, deleted: false, blob });
    const ext = emptyVaultV2();
    await s.sync(ext, new HlcClock("ext", () => 1000));
    expect(ext.entries.get("1")).toMatchObject({
      deleted: false,
      data: { type: "login", name: "Old" },
    });
  });
});

describe("p2p sync: attachment merge on conflict", () => {
  const KEY = toBase64(new Uint8Array(32).fill(9));
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const file = (n: number): Attachment => ({
    id: uuid(n),
    name: `f${n}.bin`,
    mime: "application/octet-stream",
    size: 300_000,
    chunks: 2,
    sha256: "b".repeat(64),
    key: KEY,
  });
  const files = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => file(from + i));
  const withFiles = (name: string, attachments: Attachment[], note = ""): EntryContentV3 => ({
    ...login(name),
    note,
    attachments,
  });
  const fileIds = (v: LocalVaultV2, id = "1") => {
    const e = v.entries.get(id);
    return e && !e.deleted ? (e.data.attachments ?? []).map((a) => a.id) : undefined;
  };
  const counting = (s: ReturnType<typeof setup>) => {
    const requests: P2pSyncRequest[] = [];
    const sync = (vault: LocalVaultV2, clock: HlcClock) =>
      syncVaultV2(vault, s.vaultKey, clock, async (r) => {
        requests.push(structuredClone(r));
        return s.send(r);
      });
    return { requests, sync };
  };

  /** Both devices hold entry "1" in sync; each clock reads t at the time of the call. */
  async function twoDevices() {
    const s = setup();
    const a = emptyVaultV2();
    const b = emptyVaultV2();
    const time = { t: 1000 };
    const aClock = new HlcClock("a", () => time.t);
    const bClock = new HlcClock("b", () => time.t);
    upsertEntryV2(a, aClock, "1", login("Start"));
    await s.sync(a, aClock);
    await s.sync(b, bClock);
    return { s, a, b, aClock, bClock, time };
  }

  it("remote wins: the merged list (winner first) is pushed back and reaches both devices", async () => {
    const { s, a, b, aClock, bClock, time } = await twoDevices();
    time.t = 2000;
    upsertEntryV2(a, aClock, "1", withFiles("Start", [file(1)]));
    time.t = 3000;
    upsertEntryV2(b, bClock, "1", withFiles("From B", [file(2)]));
    await s.sync(b, bClock);
    const winnerHlc = b.entries.get("1")!.data.hlc;
    const counted = counting(s);
    await counted.sync(a, aClock);
    // One request lost the conflict, the next pushed the merged list.
    expect(counted.requests).toHaveLength(2);
    await s.sync(b, bClock);

    for (const v of [a, b]) {
      expect(fileIds(v)).toEqual([uuid(2), uuid(1)]);
      expect(v.entries.get("1")).toMatchObject({ dirty: false, data: { name: "From B" } });
    }
    // The merged version is a new change, ordered after the winner it was built from.
    expect(compareHlc(a.entries.get("1")!.data.hlc, winnerHlc)).toBeGreaterThan(0);
  });

  it("local wins: the loser's files are appended and the entry gets a fresh HLC", async () => {
    const { s, a, b, aClock, bClock, time } = await twoDevices();
    time.t = 2000;
    upsertEntryV2(b, bClock, "1", withFiles("From B", [file(2)]));
    await s.sync(b, bClock);
    time.t = 3000;
    upsertEntryV2(a, aClock, "1", withFiles("From A", [file(1)]));
    const before = a.entries.get("1")!.data.hlc;
    await s.sync(a, aClock);
    await s.sync(b, bClock);

    for (const v of [a, b]) {
      expect(fileIds(v)).toEqual([uuid(1), uuid(2)]);
      expect(v.entries.get("1")).toMatchObject({ dirty: false, data: { name: "From A" } });
    }
    expect(compareHlc(a.entries.get("1")!.data.hlc, before)).toBeGreaterThan(0);
  });

  it("a tombstone with a later HLC deletes the entry with its files", async () => {
    const { s, a, b, aClock, bClock, time } = await twoDevices();
    time.t = 2000;
    upsertEntryV2(a, aClock, "1", withFiles("Start", [file(1)]));
    time.t = 3000;
    deleteEntryV2(b, bClock, "1");
    await s.sync(b, bClock);
    await s.sync(a, aClock);
    await s.sync(b, bClock);

    for (const v of [a, b]) {
      expect(v.entries.get("1")).toMatchObject({ deleted: true, dirty: false });
    }
  });

  it("keeps the winner's list when the merged one would exceed the parser limit", async () => {
    const { s, a, b, aClock, bClock, time } = await twoDevices();
    time.t = 2000;
    upsertEntryV2(a, aClock, "1", withFiles("Start", files(100, 20)));
    time.t = 3000;
    upsertEntryV2(b, bClock, "1", withFiles("Start", files(200, 21)));
    expect(20 + 21).toBeGreaterThan(MAX_ATTACHMENTS_PARSED);
    await s.sync(b, bClock);
    const counted = counting(s);
    await counted.sync(a, aClock);

    expect(counted.requests).toHaveLength(1);
    expect(fileIds(a)).toEqual(files(200, 21).map((f) => f.id));
    expect(a.entries.get("1")!.dirty).toBe(false);
  });

  it("keeps the winner's list when the merged entry would be too large to sync", async () => {
    const { s, a, b, aClock, bClock, time } = await twoDevices();
    time.t = 2000;
    upsertEntryV2(a, aClock, "1", withFiles("Start", [file(1)]));
    time.t = 3000;
    // Fits on its own, but not with one more descriptor.
    const note = "n".repeat(48_560);
    upsertEntryV2(b, bClock, "1", withFiles("Start", [file(2)], note));
    const merged = {
      ...(b.entries.get("1")!.data as EntryContentV3),
      attachments: [file(2), file(1)],
    };
    expect(entryBlobLength({ ...merged, v: 3, hlc: { ms: 9999, c: 0, d: "a" } })).toBeGreaterThan(
      MAX_ENTRY_BLOB_LENGTH,
    );
    await s.sync(b, bClock);
    await s.sync(a, aClock);

    expect(fileIds(a)).toEqual([uuid(2)]);
    expect(a.entries.get("1")!.dirty).toBe(false);
  });

  it("no extra round when both versions hold the same files", async () => {
    const { s, a, b, aClock, bClock, time } = await twoDevices();
    time.t = 2000;
    upsertEntryV2(a, aClock, "1", withFiles("From A", [file(1)]));
    time.t = 3000;
    upsertEntryV2(b, bClock, "1", withFiles("From B", [file(1)]));
    await s.sync(b, bClock);
    const counted = counting(s);
    await counted.sync(a, aClock);

    expect(counted.requests).toHaveLength(1);
    expect(fileIds(a)).toEqual([uuid(1)]);
    expect(a.entries.get("1")).toMatchObject({ dirty: false, data: { name: "From B" } });
  });

  it("a non-dirty local entry simply takes the remote version", async () => {
    const { s, a, b, aClock, bClock, time } = await twoDevices();
    time.t = 2000;
    upsertEntryV2(a, aClock, "1", withFiles("Start", [file(1)]));
    await s.sync(a, aClock);
    await s.sync(b, bClock);
    time.t = 3000;
    // B removes the file; A has nothing pending, so the file must not come back.
    upsertEntryV2(b, bClock, "1", login("Start"));
    await s.sync(b, bClock);
    await s.sync(a, aClock);
    expect(fileIds(a)).toEqual([]);
    expect(a.entries.get("1")!.data).not.toHaveProperty("attachments");
  });
});
