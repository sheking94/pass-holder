import { describe, expect, it } from "vitest";
import { AUTO_LOCK_ALARM, IDLE_CHECK_INTERVAL_MS, onAutoLockAlarm, scheduleAutoLock, watchIdle, type AlarmApi } from "../src/auto-lock.ts";
import { ACTIVITY_WRITE_INTERVAL_MS, AUTO_LOCK_MS, memoryStore, STORAGE_KEYS, VaultStore } from "../src/vault-store.ts";
import { pairedBrowser } from "./fake-phone.ts";

function fakeAlarms() {
  const alarms = new Map<string, number>();
  const api: AlarmApi = {
    create: (name, { when }) => void alarms.set(name, when),
    clear: (name) => void alarms.delete(name),
  };
  return { alarms, api };
}

/** A browser paired with a fake phone (cheapest allowed KDF), unlocked, with an empty vault. */
async function unlockedBrowser(clock: { now: number }) {
  const now = () => clock.now;
  const { local, session, store } = await pairedBrowser({ now });
  return { local, session, store, now };
}

describe("VaultStore auto-lock while a page is open (S1)", () => {
  it("refuses to use the vault after 15 minutes without activity, even before the page locks", async () => {
    const clock = { now: 1_000_000 };
    const { store } = await unlockedBrowser(clock);
    expect(store.entries()).toEqual([]);
    clock.now += AUTO_LOCK_MS;
    expect(store.isUnlocked()).toBe(false);
    expect(() => store.entries()).toThrow("Sejf jest zablokowany");
    await expect(store.upsert("1", { name: "a", username: "b", password: "c" })).rejects.toThrow("Sejf jest zablokowany");
  }, 30_000);

  it("lockIfIdle locks the page and removes the keys from session storage once the deadline passes", async () => {
    const clock = { now: 1_000_000 };
    const { store, session } = await unlockedBrowser(clock);
    expect(await store.lockIfIdle()).toBe(false);
    clock.now += AUTO_LOCK_MS + 1;
    expect(await store.lockIfIdle()).toBe(true);
    expect(await session.get(STORAGE_KEYS.sessionKeys)).toBeUndefined();
    expect(await store.lockIfIdle()).toBe(false); // already locked: the page is told only once
  }, 30_000);

  it("activity moves the deadline, but writes it at most every 30 s and never after it passed", async () => {
    const clock = { now: 1_000_000 };
    const { store, session } = await unlockedBrowser(clock);
    const start = store.unlockedUntil()!;
    clock.now += ACTIVITY_WRITE_INTERVAL_MS / 2;
    await store.noteActivity();
    expect(store.unlockedUntil()).toBe(start); // too soon to write again

    clock.now += AUTO_LOCK_MS - ACTIVITY_WRITE_INTERVAL_MS;
    await store.noteActivity();
    expect(store.unlockedUntil()).toBe(clock.now + AUTO_LOCK_MS);
    expect((await session.get<{ unlockedUntil: number }>(STORAGE_KEYS.sessionKeys))!.unlockedUntil).toBe(clock.now + AUTO_LOCK_MS);

    clock.now += AUTO_LOCK_MS;
    await store.noteActivity();
    expect(store.isUnlocked()).toBe(false);
  }, 30_000);

  it("a page adopts a deadline moved by another page, and locks when another page locked", async () => {
    const clock = { now: 1_000_000 };
    const { local, session, store: tab } = await unlockedBrowser(clock);
    const popup = new VaultStore(local, session, undefined, () => clock.now);

    clock.now += AUTO_LOCK_MS - 1000;
    expect(await popup.resume()).toBe(true); // the popup opened: the deadline moves for everyone
    clock.now += 2000;
    expect(await tab.lockIfIdle()).toBe(false);
    expect(tab.entries()).toEqual([]);

    await popup.lock();
    expect(await tab.lockIfIdle()).toBe(true);
  }, 30_000);
});

describe("service worker alarm (S1)", () => {
  it("follows the deadline and removes the keys when it fires after the deadline", async () => {
    const { alarms, api } = fakeAlarms();
    const session = memoryStore();
    await scheduleAutoLock(api, { unlockedUntil: 5000 });
    expect(alarms.get(AUTO_LOCK_ALARM)).toBe(5000);

    await session.set(STORAGE_KEYS.sessionKeys, { unlockedUntil: 9000 });
    await onAutoLockAlarm(session, api, 5000); // activity moved the deadline after the alarm was set
    expect(await session.get(STORAGE_KEYS.sessionKeys)).toBeDefined();
    expect(alarms.get(AUTO_LOCK_ALARM)).toBe(9000);

    await onAutoLockAlarm(session, api, 9000);
    expect(await session.get(STORAGE_KEYS.sessionKeys)).toBeUndefined();

    await scheduleAutoLock(api, undefined); // locked: no alarm
    expect(alarms.has(AUTO_LOCK_ALARM)).toBe(false);
  });
});

describe("watchIdle (S1)", () => {
  it("checks on a timer and on visibility, notes clicks and keys, and reports a lock", async () => {
    const listeners = new Map<string, () => void>();
    let tick: () => void = () => {};
    let interval = 0;
    const page = {
      addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
      setInterval: (h: () => void, ms: number) => { tick = h; interval = ms; },
    };
    let idle = false;
    let activity = 0;
    let locked = 0;
    watchIdle({ lockIfIdle: async () => idle, noteActivity: async () => void activity++ }, page, () => locked++);

    expect(interval).toBe(IDLE_CHECK_INTERVAL_MS);
    listeners.get("pointerdown")!();
    listeners.get("keydown")!();
    expect(activity).toBe(2);
    tick();
    await Promise.resolve();
    expect(locked).toBe(0);
    idle = true;
    listeners.get("visibilitychange")!();
    await new Promise((r) => setTimeout(r, 0));
    expect(locked).toBe(1);
  });
});
