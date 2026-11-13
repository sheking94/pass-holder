import { editTarget } from "../page-mode.ts";
import { MAX_PIN_ATTEMPTS } from "../pin-lock.ts";
import type { PinStatus } from "../pin-store.ts";
import { busy, confirmButton, form, h, passwordField, pinInput, setStatus, show, statusLine } from "../ui/dom.ts";
import type { SaveInfoMessage, SavePromptInfo } from "../save/messages.ts";
import { activeTab } from "../ui/active-tab.ts";
import { MODE, openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { showConnect } from "./connect.ts";
import { editView } from "./edit.ts";
import { listView } from "./list.ts";
import { saveQuestionView } from "./save-question.ts";
import { transferView } from "./transfer.ts";

const SHORT_PIN_MOVED =
  "Krótki PIN nie jest już zapisywany na dysku: działa do zamknięcia przeglądarki. Aby pamiętać PIN po restarcie, ustaw dłuższy (przycisk PIN).";

/** The PIN screen when the PIN is on, otherwise the master password screen. */
export async function showLocked(message = "") {
  const pin = await store.pinStatus();
  if (pin) pinLockedView(pin, message);
  else lockedView(message);
}

/**
 * What this page shows once unlocked: the transfer tab stays on import and export, the edit tab shows its
 * entry's form (a new one when the entry is gone), everything else shows the list.
 */
export async function showUnlocked(message = "") {
  if (MODE === "transfer") return transferView();
  if (MODE === "edit") {
    const target = editTarget(location.search);
    if (target) {
      const exists = target.id !== undefined && store.getEntry(target.id)?.data.type === target.type;
      return editView(target.type, exists ? target.id : undefined);
    }
  }
  const info = await pendingSaveInfo();
  if (info) saveQuestionView(info);
  else listView(message);
}

/** The save question for the tab the popup is open over, if the service worker holds a candidate for it. */
async function pendingSaveInfo(): Promise<SavePromptInfo | undefined> {
  try {
    const tab = await activeTab();
    if (!tab) return undefined;
    const message: SaveInfoMessage = { target: "background", type: "save-info", tabId: tab.id };
    return ((await chrome.runtime.sendMessage(message)) as SavePromptInfo | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

function pinLockedView(pinStatus: PinStatus, message = "") {
  // A remembered PIN is a long one; a short one from before that rule still opens it (see PinStore.unlock).
  const pin = pinInput("off", pinStatus.rememberedAfterRestart);
  const status = statusLine();
  setStatus(status, message);
  if (pinStatus.attemptsLeft < MAX_PIN_ATTEMPTS) setStatus(status, `Pozostało prób: ${pinStatus.attemptsLeft}.`, true);
  const unlock = () =>
    busy(status, "Sprawdzam PIN…", async () => {
      let movedToMemory: boolean;
      try {
        ({ movedToMemory } = await store.unlockWithPin(pin.value));
      } catch (error) {
        // After the last wrong attempt the PIN is gone: move to the master password screen.
        if (!(await store.pinStatus())) return lockedView((error as Error).message);
        pin.value = "";
        throw error;
      }
      await showUnlocked(movedToMemory ? SHORT_PIN_MOVED : "");
    });

  show(
    openInTabButton(),
    h("h1", {}, "PassHolder jest zablokowany"),
    form(
      () => void unlock(),
      h("label", {}, "PIN"),
      passwordField(pin).row,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", class: "primary" }, "Odblokuj"),
        h("button", { type: "button", onclick: () => lockedView() }, "Użyj hasła głównego"),
      ),
    ),
    status,
  );
  pin.focus();
}

function lockedView(message = "") {
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const status = statusLine();
  setStatus(status, message, Boolean(message));
  const unlock = () =>
    busy(status, "Odblokowuję…", async () => {
      await store.unlock(password.value);
      await showUnlocked();
    });

  // Forgets only this browser's copy; the phone keeps what it has synced (remove the browser there in
  // "Urządzenia"). While locked the unsynced changes cannot be counted, so the warning says they may exist.
  // The store still refuses if the vault is unlocked with unsynced changes; busy() then shows how many.
  const disconnect = confirmButton(
    "Odłącz tę przeglądarkę",
    {
      type: "button",
      class: "danger",
      title: "Usuwa sejf z tej przeglądarki. Telefon zachowuje hasła z ostatniej synchronizacji; niezsynchronizowane zmiany z tej przeglądarki mogą przepaść.",
    },
    () =>
      void busy(status, "Odłączam…", async () => {
        await store.disconnect();
        await showConnect();
      }),
    "Niezsynchronizowane zmiany mogą przepaść. Kliknij ponownie",
  );

  show(
    openInTabButton(),
    h("h1", {}, "PassHolder jest zablokowany"),
    h("p", { class: "hint" }, "Hasło główne sejfu z telefonu. Odblokowanie działa także bez połączenia z telefonem."),
    form(
      () => void unlock(),
      h("label", {}, "Hasło główne"),
      passwordField(password).row,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Odblokuj"), disconnect),
    ),
    status,
  );
  password.focus();
}
