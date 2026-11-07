import { describe, expect, it } from "vitest";
import { fromBase64 } from "@passholder/core";
import { createPinLock, INVALID_REMEMBERED_PIN, MAX_PIN_ATTEMPTS, openPinLock, type PinLock } from "../src/pin-lock.ts";
import { memoryStore, STORAGE_KEYS, VaultStore } from "../src/vault-store.ts";
import { pairedBrowser, PASSWORD } from "./fake-phone.ts";

const PIN = "4821";
/** A PIN kept on disk must be long (S4 of the security review). */
const LONG_PIN = "kot-4821-psa";

/** A browser with a vault and one entry, locked, with the PIN on. */
async function lockedBrowserWithPin(rememberAfterRestart = false, pin = rememberAfterRestart ? LONG_PIN : PIN) {
  const { local, session, store, makeClient } = await pairedBrowser();
  await store.upsert("1", { name: "bank.pl", username: "jan", password: "s3cret" });
  await store.enablePin(pin, rememberAfterRestart);
  await store.lock();
  return { local, session, store, makeClient };
}

const names = (store: VaultStore) => store.entries().map((e) => e.data.name);

describe("Unlocking with a PIN", () => {
  it("unlocks with the PIN, and the keys it restores can still sync", async () => {
    const { store } = await lockedBrowserWithPin();
    expect(store.isUnlocked()).toBe(false);
    expect(await store.pinStatus()).toEqual({ rememberedAfterRestart: false, attemptsLeft: MAX_PIN_ATTEMPTS });

    await store.unlockWithPin(PIN);
    expect(names(store)).toEqual(["bank.pl"]);
    await store.sync(); // the static key is unsealed with the vault key that came out of the PIN lock
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
    const restarted = new VaultStore(memoryOnly.local, memoryStore(), memoryOnly.makeClient); // session storage is empty after a restart
    expect(await restarted.pinStatus()).toBeUndefined();

    const remembered = await lockedBrowserWithPin(true);
    expect(await remembered.session.get(STORAGE_KEYS.pinLock)).toBeUndefined();
    const restarted2 = new VaultStore(remembered.local, memoryStore(), remembered.makeClient);
    expect(await restarted2.pinStatus()).toEqual({ rememberedAfterRestart: true, attemptsLeft: MAX_PIN_ATTEMPTS });
    expect(await restarted2.unlockWithPin(LONG_PIN)).toEqual({ movedToMemory: false });
    expect(names(restarted2)).toEqual(["bank.pl"]);
  }, 60_000);

  it("keeps only encrypted keys in the PIN lock and removes it on disable and disconnect", async () => {
    const { store, local } = await lockedBrowserWithPin(true);
    await store.unlock(PASSWORD);
    const lock = await local.get<PinLock>(STORAGE_KEYS.pinLock);
    expect(Object.keys(lock!).sort()).toEqual(["failedAttempts", "kdf", "wrappedKeys"]);
    // Only the vault key is wrapped; the P2P static key is sealed under it in the account.
    expect(Object.keys(await openPinLock(LONG_PIN, lock!))).toEqual(["vaultKey"]);
    expect(lock!.kdf.salt).not.toBe((await store.getAccount())!.kdf.salt);

    await store.disablePin();
    expect(await store.pinStatus()).toBeUndefined();

    await store.enablePin("654321-abc", true);
    await store.disconnect({ force: true }); // the vault has an unsynced entry; the user confirmed
    expect(await local.get(STORAGE_KEYS.pinLock)).toBeUndefined();
  }, 60_000);

  it("keeps a PIN on disk only if it is long, and accepts a long PIN in memory too (S4)", async () => {
    const { store, local, session } = await lockedBrowserWithPin(false, LONG_PIN);
    await store.unlockWithPin(LONG_PIN);
    for (const shortOrDigits of ["4821", "123456", "12345678901"]) {
      await expect(store.enablePin(shortOrDigits, true)).rejects.toThrow(INVALID_REMEMBERED_PIN);
    }
    expect(await session.get(STORAGE_KEYS.pinLock)).toBeDefined(); // the old PIN is still on
    expect(await local.get(STORAGE_KEYS.pinLock)).toBeUndefined();
    await store.enablePin("1234567a", true);
    expect(await store.pinStatus()).toEqual({ rememberedAfterRestart: true, attemptsLeft: MAX_PIN_ATTEMPTS });
  }, 60_000);

  it("moves a short PIN saved on disk by an older version to memory after it unlocks once (S4)", async () => {
    const { store, local, session } = await lockedBrowserWithPin();
    // What version 1.0 saved with "remember after restart": a 4-digit PIN in local storage.
    await store.unlock(PASSWORD);
    const keys = (await session.get<{ vaultKey: string }>(STORAGE_KEYS.sessionKeys))!;
    await store.disablePin();
    await local.set(STORAGE_KEYS.pinLock, await createPinLock(PIN, { vaultKey: fromBase64(keys.vaultKey) }));
    await store.lock();
    expect(await store.pinStatus()).toEqual({ rememberedAfterRestart: true, attemptsLeft: MAX_PIN_ATTEMPTS });

    expect(await store.unlockWithPin(PIN)).toEqual({ movedToMemory: true });
    expect(names(store)).toEqual(["bank.pl"]);
    expect(await local.get(STORAGE_KEYS.pinLock)).toBeUndefined();
    expect(await store.pinStatus()).toEqual({ rememberedAfterRestart: false, attemptsLeft: MAX_PIN_ATTEMPTS });
    await store.lock();
    expect(await store.unlockWithPin(PIN)).toEqual({ movedToMemory: false }); // still works until the browser closes
  }, 60_000);

  it("needs an unlocked vault to turn the PIN on", async () => {
    const { store } = await lockedBrowserWithPin();
    await expect(store.enablePin("9999", false)).rejects.toThrow("zablokowany");
  }, 60_000);
});
