import { describe, expect, it } from "vitest";
import { MemorySyncStore, processSync } from "../src/protocol.ts";
import { deleteEntry, emptyVault, liveEntries, syncVault, upsertEntry, type LocalVault } from "../src/sync.ts";
import { newVaultKey } from "../src/vault.ts";

function setup() {
  const store = new MemorySyncStore();
  const vaultKey = newVaultKey();
  const send = async (req: Parameters<typeof processSync>[1]) => structuredClone(processSync(store, structuredClone(req)));
  const sync = (vault: LocalVault) => syncVault(vault, vaultKey, send);
  return { store, sync };
}

const names = (v: LocalVault) => liveEntries(v).map((e) => e.data.name).sort();

describe("sync", () => {
  it("moves entries between two devices", async () => {
    const { sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", { name: "a.com", username: "u", password: "p" }, 100);
    await sync(phone);
    await sync(browser);
    expect(names(browser)).toEqual(["a.com"]);
    expect([...phone.entries.values()].every((e) => !e.dirty)).toBe(true);
  });

  it("resolves a conflict by last write wins, on both devices", async () => {
    const { sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", { name: "a.com", username: "u", password: "old" }, 100);
    await sync(phone);
    await sync(browser);

    upsertEntry(phone, "1", { name: "a.com", username: "u", password: "phone" }, 300);
    upsertEntry(browser, "1", { name: "a.com", username: "u", password: "browser" }, 200);
    await sync(browser); // browser's older edit reaches the server first
    await sync(phone); // phone's newer edit conflicts and wins
    await sync(browser);

    expect(phone.entries.get("1")!.data).toMatchObject({ password: "phone" });
    expect(browser.entries.get("1")!.data).toMatchObject({ password: "phone" });
  });

  it("lets an older local edit lose to a newer remote one", async () => {
    const { sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", { name: "a.com", username: "u", password: "old" }, 100);
    await sync(phone);
    await sync(browser);
    upsertEntry(browser, "1", { name: "a.com", username: "u", password: "new" }, 300);
    upsertEntry(phone, "1", { name: "a.com", username: "u", password: "stale" }, 200);
    await sync(browser);
    await sync(phone);
    expect(phone.entries.get("1")!.data).toMatchObject({ password: "new" });
    expect(phone.entries.get("1")!.dirty).toBe(false);
  });

  it("syncs deletions as tombstones", async () => {
    const { sync, store } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", { name: "a.com", username: "u", password: "p" }, 100);
    upsertEntry(phone, "2", { name: "b.com", username: "u", password: "p" }, 100);
    await sync(phone);
    await sync(browser);
    deleteEntry(browser, "1", 200);
    await sync(browser);
    await sync(phone);
    expect(names(phone)).toEqual(["b.com"]);
    expect(store.get("1")!.deleted).toBe(true);
  });

  it("drops a never-synced entry locally instead of sending a tombstone", async () => {
    const vault = emptyVault();
    upsertEntry(vault, "1", { name: "a.com", username: "u", password: "p" });
    deleteEntry(vault, "1");
    expect(vault.entries.size).toBe(0);
  });

  it("server only ever sees ciphertext", async () => {
    const { sync, store } = setup();
    const phone = emptyVault();
    upsertEntry(phone, "1", { name: "secret-site.com", username: "me", password: "hunter2" }, 100);
    await sync(phone);
    expect(JSON.stringify(store.listSince(0))).not.toMatch(/secret-site|hunter2/);
  });
});
