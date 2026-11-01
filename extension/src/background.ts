import { AUTO_LOCK_ALARM, onAutoLockAlarm, scheduleAutoLock } from "./auto-lock.ts";
import { CLEAR_AFTER_MINUTES, CLEAR_CLIPBOARD_ALARM, type ClipboardMessage } from "./clipboard.ts";
import { chromeStore, STORAGE_KEYS } from "./storage.ts";

// The popup closes as soon as it loses focus, so the one-minute timer lives here, in an alarm that
// survives the service worker being stopped.

chrome.runtime.onMessage.addListener((message: ClipboardMessage) => {
  if (message.target !== "background" || message.type !== "password-copied") return;
  void (async () => {
    await chrome.storage.session.set({ copiedPasswordHash: message.hash });
    await chrome.alarms.create(CLEAR_CLIPBOARD_ALARM, { delayInMinutes: CLEAR_AFTER_MINUTES });
  })();
});

// Auto-lock also when no PassHolder page is open: follow the deadline the pages write (see auto-lock.ts).
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[STORAGE_KEYS.sessionKeys];
  if (change) void scheduleAutoLock(chrome.alarms, change.newValue as { unlockedUntil: number } | undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEAR_CLIPBOARD_ALARM) void clearClipboard();
  if (alarm.name === AUTO_LOCK_ALARM) void onAutoLockAlarm(chromeStore(chrome.storage.session), chrome.alarms);
});

async function clearClipboard() {
  const { copiedPasswordHash } = await chrome.storage.session.get("copiedPasswordHash");
  if (typeof copiedPasswordHash !== "string") return;
  await chrome.storage.session.remove("copiedPasswordHash");
  // A service worker has no clipboard; an offscreen document is Chrome's way to reach it.
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Clear a copied password from the clipboard after one minute",
    });
  }
  await chrome.runtime.sendMessage({ target: "offscreen", type: "clear-if-unchanged", hash: copiedPasswordHash } satisfies ClipboardMessage);
  await chrome.offscreen.closeDocument();
}
