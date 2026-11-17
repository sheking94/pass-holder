import { AUTO_LOCK_ALARM, onAutoLockAlarm, scheduleAutoLock } from "./auto-lock.ts";
import { CLEAR_AFTER_MINUTES, CLEAR_CLIPBOARD_ALARM, type ClipboardMessage } from "./clipboard.ts";
import {
  chromeFillTabApi,
  fillTab,
  onFillCommand,
  type FillMessage,
  UNSUPPORTED_PAGE,
} from "./autofill/fill-tab.ts";
import { chromeSaveWatchApi, syncSaveWatch } from "./save/registration.ts";
import { SaveCandidates } from "./save/candidates.ts";
import type {
  SaveAnswerMessage,
  SaveCandidateMessage,
  SaveInfoMessage,
  SavePendingMessage,
  SavePreviewMessage,
  SaveUnlockMessage,
} from "./save/messages.ts";
import { chromeWindowApi, PromptWindows } from "./save/prompt-window.ts";
import { chromeStore, STORAGE_KEYS } from "./storage.ts";
import { VaultStore } from "./vault-store.ts";

/**
 * A page of this extension (popup, tab, question window), not its content script running inside a web page
 * (review V3-I4): only those may ask to fill a tab or to clear the clipboard.
 */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    (sender.url ?? "").startsWith(`chrome-extension://${chrome.runtime.id}/`)
  );
}

// The popup closes as soon as it loses focus, so the one-minute timer lives here, in an alarm that
// survives the service worker being stopped.

function onPasswordCopied(
  message: ClipboardMessage & { type: "password-copied" },
  sender: chrome.runtime.MessageSender,
): void {
  if (!fromExtensionPage(sender)) return;
  void (async () => {
    await chrome.storage.session.set({ [STORAGE_KEYS.copiedPasswordHash]: message.hash });
    await chrome.alarms.create(CLEAR_CLIPBOARD_ALARM, { delayInMinutes: CLEAR_AFTER_MINUTES });
  })();
}

// Autofill: a fresh store per event, because the service worker may have been stopped in between.
const newStore = () =>
  new VaultStore(chromeStore(chrome.storage.local), chromeStore(chrome.storage.session));

function onFill(
  message: FillMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): true | undefined {
  // Other extensions arrive at onMessageExternal; the sender URL also keeps out this extension's own content scripts.
  if (!fromExtensionPage(sender)) return undefined;
  void fillTab(newStore(), chromeFillTabApi(), message.tabId, message.entryId)
    .catch(() => ({ ok: false, error: UNSUPPORTED_PAGE }))
    .then(sendResponse);
  return true;
}

// Save prompt: candidates live in session storage, so a stopped service worker loses nothing.
const promptWindows = new PromptWindows(
  chromeWindowApi(),
  chromeStore(chrome.storage.session),
  (id) => chrome.runtime.getURL("save-prompt.html") + "?id=" + encodeURIComponent(id),
);
const saveCandidates = new SaveCandidates({
  store: newStore,
  session: chromeStore(chrome.storage.session),
  local: chromeStore(chrome.storage.local),
  selfId: chrome.runtime.id,
  prompt: promptWindows,
  alarms: chrome.alarms,
  now: Date.now,
  newId: () => crypto.randomUUID(),
  later: (ms, fn) => void setTimeout(fn, ms),
});

type SaveMessage =
  | SaveCandidateMessage
  | SavePendingMessage
  | SaveInfoMessage
  | SaveAnswerMessage
  | SavePreviewMessage
  | SaveUnlockMessage;
function onSaveMessage(
  m: SaveMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): true | undefined {
  const run = <T>(work: Promise<T>, onError: T) => {
    work
      .catch((error: unknown) => {
        console.warn("PassHolder: save message failed", error);
        return onError;
      })
      .then(sendResponse);
    return true as const;
  };
  switch (m.type) {
    case "save-candidate":
      return run(
        saveCandidates.onCandidate(m, sender).then(() => ({})),
        {},
      );
    case "save-pending":
      return run(saveCandidates.onPending(m, sender), {});
    case "save-info":
      return run(saveCandidates.onInfo(m, sender), undefined);
    case "save-preview":
      return run(saveCandidates.onPreview(m, sender), undefined);
    case "save-answer":
      return run(saveCandidates.onAnswer(m, sender), { ok: false, error: UNSUPPORTED_PAGE });
    case "save-unlock":
      return run(unlockForSave(m, sender), undefined);
    default:
      return undefined;
  }
}

type BackgroundMessage = ClipboardMessage | FillMessage | SaveMessage;

/** The one listener for messages to the service worker; true keeps the channel open for an async answer. */
chrome.runtime.onMessage.addListener(
  (message: { target?: string } & Partial<BackgroundMessage>, sender, sendResponse) => {
    if (message.target !== "background") return;
    const m = message as BackgroundMessage;
    switch (m.type) {
      case "password-copied":
        onPasswordCopied(m, sender);
        return;
      case "clear-if-unchanged":
        return; // for the offscreen document
      case "fill":
        return onFill(m, sender, sendResponse);
      default:
        return onSaveMessage(m, sender, sendResponse);
    }
  },
);

/** The question window has no toolbar: bring the candidate's tab forward and open the popup there to unlock. */
async function unlockForSave(
  m: SaveUnlockMessage,
  sender: chrome.runtime.MessageSender,
): Promise<undefined> {
  const tabId = await saveCandidates.onUnlockRequest(m, sender);
  if (tabId === undefined) return undefined;
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId === undefined) return undefined;
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.action.openPopup({ windowId: tab.windowId });
  return undefined;
}

// Closed with the window's own close button: the question stays behind the badge until it expires.
chrome.windows.onRemoved.addListener((windowId) => {
  void promptWindows.closedByUser(windowId).then((tabId) => {
    if (tabId !== undefined) return saveCandidates.onWindowClosed(tabId);
  });
});

// The https permission is the save-prompt switch: keep the script registration in step with it, also when the
// user took it away in chrome://extensions, or granted it while the popup (and its callback) was already gone.
const syncSave = () =>
  syncSaveWatch(chromeSaveWatchApi()).catch((error: unknown) =>
    console.warn("PassHolder: save-watch sync failed", error),
  );
chrome.runtime.onStartup.addListener(() => void syncSave());
chrome.runtime.onInstalled.addListener(() => void syncSave());
chrome.permissions.onAdded.addListener(() => void syncSave());
chrome.permissions.onRemoved.addListener(() => void syncSave());

chrome.tabs.onRemoved.addListener((tabId) => void saveCandidates.onTabRemoved(tabId));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "fill-login") return;
  onFillCommand(newStore(), chromeFillTabApi(), tab, () => chrome.action.openPopup()).catch(
    (error: unknown) => console.warn("PassHolder: fill command failed", error),
  );
});

// Auto-lock also when no PassHolder page is open: follow the deadline the pages write (see auto-lock.ts).
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[STORAGE_KEYS.sessionKeys];
  if (change)
    void scheduleAutoLock(chrome.alarms, change.newValue as { unlockedUntil: number } | undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEAR_CLIPBOARD_ALARM) void clearClipboard();
  void saveCandidates.onAlarm(alarm.name);
  if (alarm.name === AUTO_LOCK_ALARM)
    void onAutoLockAlarm(chromeStore(chrome.storage.session), chrome.alarms);
});

async function clearClipboard() {
  const key = STORAGE_KEYS.copiedPasswordHash;
  const { [key]: copiedPasswordHash } = await chrome.storage.session.get(key);
  if (typeof copiedPasswordHash !== "string") return;
  await chrome.storage.session.remove(key);
  // A service worker has no clipboard; an offscreen document is Chrome's way to reach it.
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Clear a copied password from the clipboard after one minute",
    });
  }
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "clear-if-unchanged",
    hash: copiedPasswordHash,
  } satisfies ClipboardMessage);
  await chrome.offscreen.closeDocument();
}
