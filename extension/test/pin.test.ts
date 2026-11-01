import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "@passholder/server/src/app.ts";
import { Database } from "@passholder/server/src/db.ts";
import { MAX_PIN_ATTEMPTS, type PinLock } from "../src/pin-lock.ts";
import { memoryStore, STORAGE_KEYS, VaultStore } from "../src/vault-store.ts";

const SETUP_TOKEN = "token";
const PASSWORD = "hasło główne do testów PIN";
const PIN = "4821";
const servers: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function startServer() {
  const app = buildApp({ db: new Database(":memory:"), setupToken: SETUP_TOKEN });
  servers.push(app);
  return app.listen({ host: "127.0.0.1", port: 0 });
}

/** A browser with a vault and one entry, locked, with the PIN on. */
async function lockedBrowserWithPin(rememberAfterRestart = false) {
  const url = await startServer();
  const local = memoryStore();
  const session = memoryStore();
  const store = new VaultStore(local, session);
  await store.createVault([url], SETUP_TOKEN, PASSWORD);
  await store.upsert("1", { name: "bank.pl", username: "jan", password: "s3cret" });
  await store.enablePin(PIN, rememberAfterRestart);
  await store.lock();
  return { url, local, session, store };
}

const names = (store: VaultStore) => store.entries().map((e) => e.data.name);

describe("Unlocking with a PIN", () => {
  it("unlocks with the PIN, and the keys it restores can still sync", async () => {
    const { store } = await lockedBrowserWithPin();
    expect(store.isUnlocked()).toBe(false);
    expect(await store.pinStatus()).toEqual({ rememberedAfterRestart: false, attemptsLeft: MAX_PIN_ATTEMPTS });

    await store.unlockWithPin(PIN);
    expect(names(store)).toEqual(["bank.pl"]);
    await store.sync(); // needs the auth key, which came out of the PIN lock too
    expect(store.pendingCount()).toBe(0);
  }, 60_000);

  it("counts wrong PINs and deletes the PIN after the last attempt", async () => {
    const { store } = await lockedBrowserWithPin();
    for (let left = MAX_PIN_ATTEMPTS - 1; left > 0; left--) {
      await expect(store.unlockWithPin("0000")).rejects.toThrow(`Pozostało prób: ${left}`);
      expect((await store.pinStatus())?.attemptsLeft).toBe(left);
    }
    await expect(store.unlockWithPin("0000")).rejects.toThrow("ostatnia próba");
    expect(await store.pinStatus()).toBeUndefined();
    await expect(store.unlockWithPin(PIN)).rejects.toThrow("PIN jest wyłączony");

    await store.unlock(PASSWORD); // the master password always works
    expect(names(store)).toEqual(["bank.pl"]);
  }, 120_000);

  it("resets the counter after a correct PIN or the master password", async () => {
    const { store } = await lockedBrowserWithPin();
    await expect(store.unlockWithPin("1111")).rejects.toThrow();
    await store.unlockWithPin(PIN);
    expect((await store.pinStatus())?.attemptsLeft).toBe(MAX_PIN_ATTEMPTS);

    await store.lock();
    await expect(store.unlockWithPin("1111")).rejects.toThrow();
    await store.unlock(PASSWORD);
    expect((await store.pinStatus())?.attemptsLeft).toBe(MAX_PIN_ATTEMPTS);
  }, 60_000);

  it("does not count input that is not 4-6 digits", async () => {
    const { store } = await lockedBrowserWithPin();
    for (const bad of ["", "123", "1234567", "12a4"]) {
      await expect(store.unlockWithPin(bad)).rejects.toThrow("od 4 do 6 cyfr");
    }
    expect((await store.pinStatus())?.attemptsLeft).toBe(MAX_PIN_ATTEMPTS);
    await expect(store.enablePin("12345678", false)).rejects.toThrow("od 4 do 6 cyfr");
  }, 60_000);

  it("forgets a session PIN when the browser restarts, keeps a remembered one", async () => {
    const memoryOnly = await lockedBrowserWithPin(false);
    expect(await memoryOnly.local.get(STORAGE_KEYS.pinLock)).toBeUndefined();
    const restarted = new VaultStore(memoryOnly.local, memoryStore()); // session storage is empty after a restart
    expect(await restarted.pinStatus()).toBeUndefined();

    const remembered = await lockedBrowserWithPin(true);
    expect(await remembered.session.get(STORAGE_KEYS.pinLock)).toBeUndefined();
    const restarted2 = new VaultStore(remembered.local, memoryStore());
    expect(await restarted2.pinStatus()).toEqual({ rememberedAfterRestart: true, attemptsLeft: MAX_PIN_ATTEMPTS });
    await restarted2.unlockWithPin(PIN);
    expect(names(restarted2)).toEqual(["bank.pl"]);
  }, 60_000);

  it("keeps only encrypted keys in the PIN lock and removes it on disable and disconnect", async () => {
    const { store, local } = await lockedBrowserWithPin(true);
    await store.unlock(PASSWORD);
    const lock = await local.get<PinLock>(STORAGE_KEYS.pinLock);
    expect(Object.keys(lock!).sort()).toEqual(["failedAttempts", "kdf", "wrappedKeys"]);
    expect(lock!.kdf.salt).not.toBe((await store.getAccount())!.kdf.salt);

    await store.disablePin();
    expect(await store.pinStatus()).toBeUndefined();

    await store.enablePin("654321", true);
    await store.disconnect();
    expect(await local.get(STORAGE_KEYS.pinLock)).toBeUndefined();
  }, 60_000);

  it("needs an unlocked vault to turn the PIN on", async () => {
    const { store } = await lockedBrowserWithPin();
    await expect(store.enablePin("9999", false)).rejects.toThrow("zablokowany");
  }, 60_000);
});
