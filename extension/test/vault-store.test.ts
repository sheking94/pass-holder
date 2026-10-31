import { afterEach, describe, expect, it } from "vitest";
import { liveEntries, upsertEntry, deleteEntry } from "@passholder/core";
import { buildApp } from "@passholder/server/src/app.ts";
import { Database } from "@passholder/server/src/db.ts";
import { memoryStore, VaultStore, AUTO_LOCK_MS } from "../src/vault-store.ts";

const SETUP_TOKEN = "token";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const servers: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function startServer() {
  const app = buildApp({ db: new Database(":memory:"), setupToken: SETUP_TOKEN });
  servers.push(app);
  return app.listen({ host: "127.0.0.1", port: 0 });
}

function newBrowser(now = () => Date.now()) {
  const local = memoryStore();
  const session = memoryStore();
  return { local, session, store: new VaultStore(local, session, undefined, now) };
}

const names = (store: VaultStore) => liveEntries({ lastSyncRevision: 0, entries: store.entries() }).map((e) => e.data.name).sort();

describe("VaultStore against the real server", () => {
  it("creates a vault, syncs, and a second browser downloads it", async () => {
    const url = await startServer();
    const first = newBrowser().store;
    await first.createVault(url, SETUP_TOKEN, PASSWORD);
    upsertEntry(first.vaultForEdit(), "1", { name: "bank.pl", username: "jan", password: "s3cret" });
    await first.save();
    await first.sync();

    const second = newBrowser().store;
    await second.connectExisting(url, PASSWORD);
    expect(names(second)).toEqual(["bank.pl"]);

    deleteEntry(second.vaultForEdit(), "1");
    await second.save();
    await second.sync();
    await first.sync();
    expect(names(first)).toEqual([]);
  }, 30_000);

  it("rejects a wrong master password when connecting", async () => {
    const url = await startServer();
    await newBrowser().store.createVault(url, SETUP_TOKEN, PASSWORD);
    await expect(newBrowser().store.connectExisting(url, "wrong")).rejects.toThrow("Złe hasło główne");
  }, 30_000);
});

describe("VaultStore offline", () => {
  it("unlocks from disk without the server and keeps entries encrypted at rest", async () => {
    const url = await startServer();
    const browser = newBrowser();
    await browser.store.createVault(url, SETUP_TOKEN, PASSWORD);
    upsertEntry(browser.store.vaultForEdit(), "1", { name: "poczta.pl", username: "jan", password: "hunter2" });
    await browser.store.save();
    await servers.splice(0)[0]!.close(); // server goes away

    await browser.store.lock();
    expect(browser.store.isUnlocked()).toBe(false);
    await expect(browser.store.unlock("wrong")).rejects.toThrow("Złe hasło główne");
    await browser.store.unlock(PASSWORD);
    expect(names(browser.store)).toEqual(["poczta.pl"]);

    const onDisk = JSON.stringify([await browser.local.get("account"), await browser.local.get("vault")]);
    expect(onDisk).not.toMatch(/poczta|hunter2/);
    await expect(browser.store.sync()).rejects.toThrow("niedostępny");
  }, 30_000);

  it("resumes without a password until auto-lock", async () => {
    const url = await startServer();
    let clock = 1_000_000;
    const browser = newBrowser(() => clock);
    await browser.store.createVault(url, SETUP_TOKEN, PASSWORD);

    const reopened = new VaultStore(browser.local, browser.session, undefined, () => clock);
    expect(await reopened.resume()).toBe(true);

    clock += AUTO_LOCK_MS + 1;
    const later = new VaultStore(browser.local, browser.session, undefined, () => clock);
    expect(await later.resume()).toBe(false);
    expect(await browser.session.get("keys")).toBeUndefined();
  }, 30_000);
});
