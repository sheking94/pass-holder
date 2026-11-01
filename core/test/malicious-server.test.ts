import { describe, expect, it } from "vitest";
import { MemorySyncStore, processSync, type RemoteRecord, type SyncRequest, type SyncResponse } from "../src/protocol.ts";
import { emptyVault, INCONSISTENT_RECORD, liveEntries, syncVault, upsertEntry, type LocalVault } from "../src/sync.ts";
import { encryptPayload, newVaultKey } from "../src/vault.ts";

/**
 * S2 of the security review: a server (or someone who swapped its SQLite file) can change the plain
 * deleted flag and revision numbers, and send back old ciphertexts. It cannot read or forge blobs.
 */
function setup() {
  const store = new MemorySyncStore();
  const vaultKey = newVaultKey();
  // The tests change the server's records directly, like someone with access to the Pi would.
  const send = async (req: SyncRequest): Promise<SyncResponse> => structuredClone(processSync(store, structuredClone(req)));
  const sync = (vault: LocalVault) => syncVault(vault, vaultKey, send);
  return { store, vaultKey, sync };
}

const entry = (password: string) => ({ name: "bank.pl", username: "jan", password });
const passwords = (v: LocalVault) => liveEntries(v).map((e) => e.data.password);

describe("a malicious server", () => {
  it("cannot delete an entry by setting deleted on its record", async () => {
    const { store, sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", entry("s3cret"), 100);
    await sync(phone);

    const record = store.get("1")!;
    store.put({ ...record, deleted: true, revision: record.revision + 1 });
    await expect(sync(phone)).rejects.toThrow(INCONSISTENT_RECORD);
    await expect(sync(browser)).rejects.toThrow(INCONSISTENT_RECORD);
    expect(passwords(phone)).toEqual(["s3cret"]); // the local copy is untouched
    expect(browser.entries.size).toBe(0);
    expect(browser.lastSyncRevision).toBe(0);
  });

  it("cannot turn a tombstone back into an entry by clearing deleted", async () => {
    const { store, sync, vaultKey } = setup();
    const phone = emptyVault();
    store.put({ id: "1", revision: 1, deleted: true, blob: await encryptPayload(vaultKey, "1", { modifiedAt: 5 }) });
    const record = store.get("1")!;
    store.put({ ...record, deleted: false, revision: 2 });
    await expect(sync(phone)).rejects.toThrow(INCONSISTENT_RECORD);
  });

  it("cannot roll an entry back to an old ciphertext on a device that has the newer one", async () => {
    const { store, sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", entry("old-password"), 100);
    await sync(phone);
    const oldRecord: RemoteRecord = structuredClone(store.get("1")!);
    upsertEntry(phone, "1", entry("new-password"), 200);
    await sync(phone);
    await sync(browser);

    // The Pi now serves the ciphertext from before the password change, as a fresh revision.
    store.put({ ...oldRecord, revision: store.currentRevision() + 1 });
    await sync(browser);
    await sync(phone);
    expect(passwords(browser)).toEqual(["new-password"]);
    expect(passwords(phone)).toEqual(["new-password"]);
    // ...and the devices pushed the newer version back, so the server has it again.
    expect(store.get("1")!.revision).toBeGreaterThan(oldRecord.revision + 1);
  });

  it("still accepts a newer version from the server over an older local change", async () => {
    const { sync } = setup();
    const phone = emptyVault();
    const browser = emptyVault();
    upsertEntry(phone, "1", entry("a"), 100);
    await sync(phone);
    await sync(browser);
    upsertEntry(browser, "1", entry("b"), 150);
    upsertEntry(phone, "1", entry("c"), 300);
    await sync(phone);
    await sync(browser);
    expect(passwords(browser)).toEqual(["c"]);
  });
});
