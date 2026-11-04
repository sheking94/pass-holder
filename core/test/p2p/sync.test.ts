import { describe, expect, it } from "vitest";
import { randomBytes, toBase64 } from "../../src/encoding.ts";
import { encryptPayload, newVaultKey } from "../../src/vault.ts";
import {
  decryptPayloadV2,
  deleteEntryV2,
  emptyVaultV2,
  encryptPayloadV2,
  HlcClock,
  liveEntriesV2,
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
    expect(response).toEqual({ epoch, currentRevision: 0, accepted: [], conflicts: [], changes: [], addresses: [ADDRESS] });
  });

  it("payloads are bound to their id and to v2", async () => {
    const key = newVaultKey();
    const data = { name: "x", username: "u", password: "p", hlc: { ms: 1, c: 0, d: "d" } };
    const blob = await encryptPayloadV2(key, "1", data);

    expect(await decryptPayloadV2(key, "1", blob)).toEqual(data);
    await expect(decryptPayloadV2(key, "2", blob)).rejects.toThrow();
    const v1 = await encryptPayload(key, "1", { name: "x", username: "u", password: "p", modifiedAt: 1 });
    await expect(decryptPayloadV2(key, "1", v1)).rejects.toThrow();
  });
});
