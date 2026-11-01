import { MAX_PIN_ATTEMPTS } from "../pin-lock.ts";
import type { PinStatus } from "../pin-store.ts";
import { busy, confirmButton, form, h, passwordField, pinInput, setStatus, show, statusLine } from "../ui/dom.ts";
import { MODE, openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { showConnect } from "./connect.ts";
import { listView } from "./list.ts";
import { transferView } from "./transfer.ts";

/** The PIN screen when the PIN is on, otherwise the master password screen. */
export async function showLocked() {
  const pin = await store.pinStatus();
  if (pin) pinLockedView(pin);
  else lockedView();
}

/** What this page shows once unlocked: the CSV tab stays on import and export, everything else shows the list. */
export function showUnlocked() {
  if (MODE === "transfer") transferView();
  else listView();
}

function pinLockedView(pinStatus: PinStatus) {
  const pin = pinInput();
  const status = statusLine();
  if (pinStatus.attemptsLeft < MAX_PIN_ATTEMPTS) setStatus(status, `Pozostało prób: ${pinStatus.attemptsLeft}.`, true);
  const unlock = () =>
    busy(status, "Sprawdzam PIN…", async () => {
      try {
        await store.unlockWithPin(pin.value);
      } catch (error) {
        // After the last wrong attempt the PIN is gone: move to the master password screen.
        if (!(await store.pinStatus())) return lockedView((error as Error).message);
        pin.value = "";
        throw error;
      }
      showUnlocked();
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
      showUnlocked();
    });

  const disconnect = confirmButton("Odłącz tę przeglądarkę", { type: "button", class: "danger" }, async () => {
    await store.disconnect();
    showConnect();
  });

  show(
    openInTabButton(),
    h("h1", {}, "PassHolder jest zablokowany"),
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
