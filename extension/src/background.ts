import { AUTO_LOCK_ALARM, onAutoLockAlarm, scheduleAutoLock } from "./auto-lock.ts";
import { CLEAR_AFTER_MINUTES, CLEAR_CLIPBOARD_ALARM, type ClipboardMessage } from "./clipboard.ts";
import { chromeTabApi, fillTab, onFillCommand, type FillMessage, UNSUPPORTED_PAGE } from "./autofill/fill-tab.ts";
import { SaveCandidates } from "./save/candidates.ts";
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
  // sender.id only limits this to this extension's own contexts (its pages and its injected content script);
  // messages from other extensions arrive at onMessageExternal and never reach this listener.
  if (sender.id !== chrome.runtime.id) return;
  void fillTab(newStore(), chromeTabApi(), message.tabId, message.entryId)
    .catch(() => ({ ok: false, error: UNSUPPORTED_PAGE }))
    .then(sendResponse);
  return true;
});

// Save prompt: candidates live in session storage, so a stopped service worker loses nothing.
const saveCandidates = new SaveCandidates({
  store: newStore,
  session: chromeStore(chrome.storage.session),
  local: chromeStore(chrome.storage.local),
  selfId: chrome.runtime.id,
  sendToTab: async (tabId, m) => {
    try {
      await chrome.tabs.sendMessage(tabId, m, { frameId: 0 });
    } catch {
      // No receiver: the tab was closed or the script is not there (permission taken away); nothing to show.
    }
  },
  alarms: chrome.alarms,
  now: Date.now,
  newId: () => crypto.randomUUID(),
  later: (ms, fn) => void setTimeout(fn, ms),
});

type SaveMessage = { target?: string; type?: string };
chrome.runtime.onMessage.addListener((message: SaveMessage, sender, sendResponse) => {
  if (message.target !== "background") return;
  const run = <T>(work: Promise<T>, onError: T) => {
    work.catch((error: unknown) => {
      console.warn("PassHolder: save message failed", error);
      return onError;
    }).then(sendResponse);
    return true;
  };
  switch (message.type) {
    case "save-candidate":
      return run(saveCandidates.onCandidate(message as never, sender).then(() => ({})), {});
    case "save-pending":
      return run(saveCandidates.onPending(message as never, sender), {});
    case "save-info":
      return run(saveCandidates.info(message as never, sender), undefined);
    case "save-answer":
      return run(saveCandidates.answer(message as never, sender), { ok: false, error: UNSUPPORTED_PAGE });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void saveCandidates.onTabRemoved(tabId));

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
  void saveCandidates.onAlarm(alarm.name);
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
