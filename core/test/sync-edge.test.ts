import { describe, expect, it } from "vitest";
import { MemorySyncStore, processSync, type SyncRequest, type SyncResponse } from "../src/protocol.ts";
import {
  applySyncResponse,
  buildSyncRequest,
  deleteEntry,
  emptyVault,
  liveEntries,
  syncVault,
  upsertEntry,
  type LocalVault,
} from "../src/sync.ts";
import { newVaultKey } from "../src/vault.ts";

function setup() {
  const store = new MemorySyncStore();
  const vaultKey = newVaultKey();
  const send = async (req: SyncRequest): Promise<SyncResponse> => structuredClone(processSync(store, structuredClone(req)));
  const sync = (vault: LocalVault) => syncVault(vault, vaultKey, send);
  return { store, vaultKey, send, sync };
}

const entry = (password: string) => ({ name: "a.com", username: "u", password });
const names = (v: LocalVault) => liveEntries(v).map((e) => e.data.name).sort();

describe("sync edge cases", () => {
  it("recovers when the server applied a change but the answer was lost (Pi switched off mid-sync)", async () => {
    const { vaultKey, send, sync, store } = setup();
    const phone = emptyVault();
    upsertEntry(phone, "1", entry("p"), 100);
    await send(await buildSyncRequest(phone, vaultKey)); // response never arrives
    expect(phone.entries.get("1")!.dirty).toBe(true);

    await sync(phone); // retry: same change, now a conflict with itself
    expect(phone.entries.get("1")).toMatchObject({ dirty: false, revision: 1, data: { password: "p" } });
    expect(store.currentRevision()).toBe(1); // nothing was stored twice
  });

  it("a newer deletion beats an older edit", async () => {
    const { sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", entry("old"), 100);
    await sync(phone);
    await sync(browser);
    upsertEntry(browser, "1", entry("edited"), 200);
    deleteEntry(phone, "1", 300);
    await sync(browser);
    await sync(phone);
    await sync(browser);
    expect(names(phone)).toEqual([]);
    expect(names(browser)).toEqual([]);
  });

  it("a newer edit brings back an entry deleted earlier elsewhere", async () => {
    const { sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", entry("old"), 100);
    await sync(phone);
    await sync(browser);
    deleteEntry(phone, "1", 200);
    upsertEntry(browser, "1", entry("edited"), 300);
    await sync(phone);
    await sync(browser);
    await sync(phone);
    expect(phone.entries.get("1")!.data).toMatchObject({ password: "edited" });
    expect(browser.entries.get("1")!.data).toMatchObject({ password: "edited" });
  });

  it("on a tie of modifiedAt the server's version wins on every device", async () => {
    const { sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", entry("old"), 100);
    await sync(phone);
    await sync(browser);
    upsertEntry(phone, "1", entry("phone"), 500);
    upsertEntry(browser, "1", entry("browser"), 500);
    await sync(phone);
    await sync(browser);
    await sync(phone);
    expect(browser.entries.get("1")!.data).toMatchObject({ password: "phone" });
    expect(phone.entries.get("1")!.data).toMatchObject({ password: "phone" });
  });

  it("three devices editing different entries all converge", async () => {
    const { sync } = setup();
    const devices = [emptyVault(), emptyVault(), emptyVault()];
    devices.forEach((d, i) => upsertEntry(d, `id-${i}`, { name: `site${i}.pl`, username: "u", password: "p" }, 100 + i));
    for (const d of devices) await sync(d);
    for (const d of devices) await sync(d);
    for (const d of devices) expect(names(d)).toEqual(["site0.pl", "site1.pl", "site2.pl"]);
    for (const d of devices) expect(d.lastSyncRevision).toBe(3);
  });

  it("re-creating an entry with the id of a synced tombstone is an edit, not a new entry", async () => {
    const { sync, store } = setup();
    const phone = emptyVault();
    upsertEntry(phone, "1", entry("a"), 100);
    await sync(phone);
    deleteEntry(phone, "1", 200);
    await sync(phone);
    upsertEntry(phone, "1", entry("b"), 300);
    expect(phone.entries.get("1")!.revision).toBe(2);
    await sync(phone);
    expect(store.get("1")).toMatchObject({ revision: 3, deleted: false });
  });

  it("a sync with nothing to do changes nothing", async () => {
    const { sync, store } = setup();
    const phone = emptyVault();
    await sync(phone);
    expect(phone.lastSyncRevision).toBe(0);
    expect(store.currentRevision()).toBe(0);
  });

  it("refuses records the server moved to another id, so the server cannot swap passwords", async () => {
    const { vaultKey, sync, store } = setup();
    const phone = emptyVault();
    upsertEntry(phone, "bank", { name: "bank.pl", username: "u", password: "bank-pass" }, 100);
    upsertEntry(phone, "mail", { name: "mail.pl", username: "u", password: "mail-pass" }, 100);
    await sync(phone);

    const bank = store.get("bank")!;
    const mail = store.get("mail")!;
    store.put({ ...bank, blob: mail.blob });
    const browser = emptyVault();
    await expect(syncVault(browser, vaultKey, async (r) => processSync(store, r))).rejects.toThrow();
    expect(browser.lastSyncRevision).toBe(0); // will fetch again next time, nothing half-applied as synced
  });

  it("refuses data encrypted with another vault key", async () => {
    const phone = emptyVault();
    upsertEntry(phone, "1", entry("p"), 100);
    const strangerStore = new MemorySyncStore();
    await syncVault(phone, newVaultKey(), async (r) => processSync(strangerStore, r));
    await expect(syncVault(emptyVault(), newVaultKey(), async (r) => processSync(strangerStore, r))).rejects.toThrow();
  });

  it("gives up after maxRounds when local changes keep winning", async () => {
    const { vaultKey } = setup();
    const phone = emptyVault();
    upsertEntry(phone, "1", entry("mine"), 1_000);
    // A server that always answers with an older conflicting version (e.g. a buggy server).
    const remote = emptyVault();
    upsertEntry(remote, "1", entry("theirs"), 1);
    const { changes } = await buildSyncRequest(remote, vaultKey);
    const stubborn = async (): Promise<SyncResponse> => ({
      currentRevision: 7,
      accepted: [],
      conflicts: [{ id: "1", revision: 7, deleted: false, blob: changes[0]!.blob }],
      changes: [],
    });
    await expect(syncVault(phone, vaultKey, stubborn, 3)).rejects.toThrow("did not settle");
    expect(phone.entries.get("1")!.data).toMatchObject({ password: "mine" });
  });

  it("ignores an accepted id it does not know", async () => {
    const vault = emptyVault();
    await applySyncResponse(vault, { currentRevision: 1, accepted: [{ id: "ghost", revision: 1 }], conflicts: [], changes: [] }, newVaultKey());
    expect(vault.entries.size).toBe(0);
  });
});

describe("processSync (server side)", () => {
  it("rejects two changes for the same entry in one request", () => {
    const store = new MemorySyncStore();
    const change = { id: "1", baseRevision: 0, deleted: false, blob: "AQ==" };
    expect(() => processSync(store, { sinceRevision: 0, changes: [change, change] })).toThrow("Duplicate");
  });

  it("rejects a base revision for an entry it never had", () => {
    expect(() =>
      processSync(new MemorySyncStore(), { sinceRevision: 0, changes: [{ id: "1", baseRevision: 3, deleted: false, blob: "AQ==" }] }),
    ).toThrow("Unknown base revision");
  });

  it("gives revisions that strictly increase and never reuses one", () => {
    const store = new MemorySyncStore();
    const r1 = processSync(store, { sinceRevision: 0, changes: [{ id: "a", baseRevision: 0, deleted: false, blob: "AQ==" }] });
    const r2 = processSync(store, {
      sinceRevision: 1,
      changes: [
        { id: "a", baseRevision: 1, deleted: true, blob: "AQ==" },
        { id: "b", baseRevision: 0, deleted: false, blob: "AQ==" },
      ],
    });
    expect(r1.accepted).toEqual([{ id: "a", revision: 1 }]);
    expect(r2.accepted).toEqual([
      { id: "a", revision: 2 },
      { id: "b", revision: 3 },
    ]);
    expect(r2.changes).toEqual([]); // own changes are not echoed back
  });

  it("returns only what changed after sinceRevision, oldest first", () => {
    const store = new MemorySyncStore();
    for (const id of ["a", "b", "c"]) processSync(store, { sinceRevision: 0, changes: [{ id, baseRevision: 0, deleted: false, blob: "AQ==" }] });
    expect(processSync(store, { sinceRevision: 1, changes: [] }).changes.map((r) => r.id)).toEqual(["b", "c"]);
    expect(processSync(store, { sinceRevision: 3, changes: [] }).changes).toEqual([]);
  });
});
