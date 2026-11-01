/**
 * Auto-lock after 15 minutes without activity (docs/POPRAWKI_BEZPIECZENSTWA.md, S1).
 *
 * Two independent guards, so the vault closes whether or not a PassHolder page is open:
 * - every open page (popup or tab) runs watchIdle(): it checks the deadline every few seconds and when
 *   the page becomes visible, and moves the deadline when the user clicks or types;
 * - the service worker keeps a chrome.alarms alarm at the deadline (scheduleAutoLock) and removes the
 *   keys from session storage when it fires (onAutoLockAlarm), even if no page is open.
 */
import { STORAGE_KEYS, type KeyValueStore } from "./storage.ts";

export const AUTO_LOCK_ALARM = "auto-lock";

/** How often an open page checks the deadline. Same as LockController.checkIdle on Android. */
export const IDLE_CHECK_INTERVAL_MS = 15_000;

/** The part of chrome.alarms the service worker uses, so tests can pass a fake. */
export interface AlarmApi {
  create(name: string, info: { when: number }): Promise<void> | void;
  clear(name: string): Promise<unknown> | void;
}

interface Deadline {
  unlockedUntil: number;
}

/** Keeps the alarm on the current deadline; no keys (locked) means no alarm. */
export async function scheduleAutoLock(alarms: AlarmApi, keys: Deadline | undefined): Promise<void> {
  if (keys && Number.isFinite(keys.unlockedUntil)) await alarms.create(AUTO_LOCK_ALARM, { when: keys.unlockedUntil });
  else await alarms.clear(AUTO_LOCK_ALARM);
}

/**
 * The alarm fired. Activity may have moved the deadline after the alarm was set (and Chrome may fire
 * alarms late, never early on purpose), so check again: lock if it has passed, otherwise wait for the new one.
 */
export async function onAutoLockAlarm(session: KeyValueStore, alarms: AlarmApi, now = Date.now()): Promise<void> {
  const keys = await session.get<Deadline>(STORAGE_KEYS.sessionKeys);
  if (!keys) return;
  if (keys.unlockedUntil <= now) await session.remove(STORAGE_KEYS.sessionKeys);
  else await scheduleAutoLock(alarms, keys);
}

/** What watchIdle needs from the page's VaultStore. */
export interface IdleWatched {
  lockIfIdle(): Promise<boolean>;
  noteActivity(): Promise<void>;
}

/** The part of the page watchIdle listens to, so tests can pass a fake. */
export interface PageEvents {
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  setInterval(handler: () => void, ms: number): unknown;
}

/**
 * Runs in every page. onLocked is called once each time the vault locks because of the deadline
 * (here, in another page or in the service worker); the page then shows the locked screen.
 */
export function watchIdle(store: IdleWatched, page: PageEvents, onLocked: () => void): void {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (await store.lockIfIdle()) onLocked();
    } finally {
      checking = false;
    }
  };
  page.setInterval(() => void check(), IDLE_CHECK_INTERVAL_MS);
  // Chrome slows timers down in background tabs: check as soon as the tab is shown again.
  page.addEventListener("visibilitychange", () => void check());
  page.addEventListener("focus", () => void check());
  // Capture phase: the deadline moves before the click handler asks the store for the vault.
  for (const type of ["pointerdown", "keydown"]) page.addEventListener(type, () => void store.noteActivity(), { capture: true });
}
