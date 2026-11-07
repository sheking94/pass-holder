import { describe, expect, it } from "vitest";
import { seal } from "../../src/cipher.ts";
import { randomBytes, toBase64, utf8 } from "../../src/encoding.ts";
import { newVaultKey } from "../../src/vault.ts";
import {
  applyVaultInfo,
  clockForVault,
  decryptPayloadV2,
  deleteEntryV2,
  emptyVaultV2,
  encryptPayloadV2,
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
  type P2pTransport,
} from "../../src/p2p/index.ts";
import { MemorySyncStore } from "../../src/protocol.ts";

const newEpoch = () => toBase64(randomBytes(16));
const ADDRESS = "192.168.1.5:8787";
const entry = (name: string) => ({ name, username: "u", password: "p" });

function setup(epoch = newEpoch()) {
  const store = new MemorySyncStore();
  const vaultKey = newVaultKey();
  const transport = (e: string): P2pTransport => async (r) =>
    structuredClone(processP2pSync(store, e, [ADDRESS], structuredClone(r)));
  const send = transport(epoch);
  const sync = (vault: LocalVaultV2, clock: HlcClock) => syncVaultV2(vault, vaultKey, clock, send);
  return { store, vaultKey, epoch, send, sync, transport };
}

const names = (v: LocalVaultV2) => liveEntriesV2(v).map((e) => e.data.name).sort();

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
    expect(await decryptPayloadV2(first.vaultKey, "a", a.blob)).toMatchObject({ name: "A edited offline" });
    expect([...ext.entries.values()].every((e) => !e.dirty)).toBe(true);
    expect(names(ext)).toEqual(["A edited offline", "B"]);
  });

  it("throws when the epoch changes twice during one sync", async () => {
    const { vaultKey } = setup();
    const a = setup();
    const b = setup();
    let n = 0;
    const flipping: P2pTransport = (r) => (n++ % 2 === 0 ? a : b).transport(n % 2 === 1 ? a.epoch : b.epoch)(r);
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
        { id: "1", baseRevision: 0, deleted: false, blob: await encryptPayloadV2(vaultKey, "1", { name: "x", username: "u", password: "p", hlc: { ms: 1, c: 0, d: "d" } }) },
      ],
    };
    const response = processP2pSync(store, epoch, [ADDRESS], request);

    expect(store.currentRevision()).toBe(0);
    expect(store.get("1")).toBeUndefined();
    expect(response).toEqual({ epoch, currentRevision: 0, accepted: [], conflicts: [], changes: [], addresses: [ADDRESS], more: false });
  });

  it("payloads are bound to their id and to v2", async () => {
    const key = newVaultKey();
    const data = { name: "x", username: "u", password: "p", hlc: { ms: 1, c: 0, d: "d" } };
    const blob = await encryptPayloadV2(key, "1", data);

    expect(await decryptPayloadV2(key, "1", blob)).toEqual(data);
    await expect(decryptPayloadV2(key, "2", blob)).rejects.toThrow();
    // A v1 payload, sealed the way the removed Pi sync did it.
    const v1 = await seal(key, utf8(JSON.stringify({ name: "x", username: "u", password: "p", modifiedAt: 1 })), "passholder/v1/entry/1");
    await expect(decryptPayloadV2(key, "1", v1)).rejects.toThrow();
  });
});

describe("p2p sync: final review fixes", () => {
  const password = async (s: ReturnType<typeof setup>, id: string) =>
    ((await decryptPayloadV2(s.vaultKey, id, s.store.get(id)!.blob)) as { password?: string }).password;

  it("an edit made while its push is in flight stays dirty and reaches the phone on the next sync", async () => {
    const s = setup();
    const ext = emptyVaultV2();
    const clock = new HlcClock("ext", () => 1000);
    upsertEntryV2(ext, clock, "1", { name: "Bank", username: "u", password: "old" });
    let edited = false;
    await syncVaultV2(ext, s.vaultKey, clock, async (r) => {
      const res = await s.send(r);
      if (!edited && r.epoch === s.epoch && r.changes.length > 0) {
        edited = true;
        upsertEntryV2(ext, clock, "1", { name: "Bank", username: "u", password: "NEW" });
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
    upsertEntryV2(phone, phoneClock, "x", { name: "X", username: "u", password: "phone-v1" });
    await first.sync(phone, phoneClock);
    await first.sync(a, new HlcClock("a", () => 1000));

    const restarted = new HlcClock("a", () => 2000);
    upsertEntryV2(a, restarted, "x", { name: "X", username: "u", password: "a-edit" });
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
    expect(second.store.listSince(0).map((r) => r.id).sort()).toEqual(["a", "b"]);

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
    expect(restored.listSince(0).map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(ext.lastSyncRevision).toBe(3);
  });
});

describe("p2p sync: paging", () => {
  it("host returns at most MAX_CHANGES_PER_RESPONSE records and continues from the last one", async () => {
    const s = setup();
    for (let i = 1; i <= 1300; i++) s.store.put({ id: `id${i}`, revision: i, deleted: false, blob: "x" });
    const page = (since: number) => processP2pSync(s.store, s.epoch, [], { epoch: s.epoch, sinceRevision: since, changes: [] });
    const first = page(0);
    expect(first.changes).toHaveLength(MAX_CHANGES_PER_RESPONSE);
    expect(first.more).toBe(true);
    expect(first.currentRevision).toBe(500);
    expect(first.changes.map((c) => c.revision)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(page(500)).toMatchObject({ more: true, currentRevision: 1000 });
    const last = page(1000);
    expect(last).toMatchObject({ more: false, currentRevision: 1300 });
    expect(last.changes).toHaveLength(300);
    expect(processP2pSync(s.store, s.epoch, [], { epoch: "", sinceRevision: 0, changes: [] }).more).toBe(false);
  });

  it("host rejects more than MAX_CHANGES_PER_REQUEST changes", () => {
    const s = setup();
    const changes = Array.from({ length: MAX_CHANGES_PER_REQUEST + 1 }, (_, i) => ({ id: `${i}`, baseRevision: 0, deleted: false, blob: "x" }));
    expect(() => processP2pSync(s.store, s.epoch, [], { epoch: s.epoch, sinceRevision: 0, changes })).toThrow("too many changes");
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
      return { epoch: s.epoch, currentRevision: 0, accepted: [], conflicts: [], changes: [], addresses: [], more: true };
    };
    await expect(syncVaultV2(ext, s.vaultKey, clock, endless)).rejects.toThrow("Sync exceeded");
    expect(calls).toBe(MAX_SYNC_ROUNDS);
  });
});
