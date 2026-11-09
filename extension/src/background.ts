import { AUTO_LOCK_ALARM, onAutoLockAlarm, scheduleAutoLock } from "./auto-lock.ts";
import { CLEAR_AFTER_MINUTES, CLEAR_CLIPBOARD_ALARM, type ClipboardMessage } from "./clipboard.ts";
import { chromeTabApi, fillTab, onFillCommand, type FillMessage } from "./autofill/fill-tab.ts";
import { chromeStore, STORAGE_KEYS } from "./storage.ts";
import { VaultStore } from "./vault-store.ts";

// The popup closes as soon as it loses focus, so the one-minute timer lives here, in an alarm that
// survives the service worker being stopped.

chrome.runtime.onMessage.addListener((message: ClipboardMessage) => {
  if (message.target !== "background" || message.type !== "password-copied") return;
  void (async () => {
    await chrome.storage.session.set({ copiedPasswordHash: message.hash });
    await chrome.alarms.create(CLEAR_CLIPBOARD_ALARM, { delayInMinutes: CLEAR_AFTER_MINUTES });
  })();
});

// Autofill: a fresh store per event, because the service worker may have been stopped in between.
const newStore = () => new VaultStore(chromeStore(chrome.storage.local), chromeStore(chrome.storage.session));

chrome.runtime.onMessage.addListener((message: FillMessage, sender, sendResponse) => {
  if (message.target !== "background" || message.type !== "fill") return;
  // Only PassHolder's own pages may ask for a fill (not other extensions, not content scripts).
  if (sender.id !== chrome.runtime.id) return;
  void fillTab(newStore(), chromeTabApi(), message.tabId, message.entryId).then(sendResponse);
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "fill-login") return;
  onFillCommand(newStore(), chromeTabApi(), tab, () => chrome.action.openPopup())
    .catch((error: unknown) => console.warn("PassHolder: fill command failed", error));
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
