import { neverList, removeFromNever } from "../save/candidates.ts";
import {
  chromeSaveWatchApi,
  disableSavePrompt,
  SAVE_ORIGINS,
  type SaveWatchApi,
} from "../save/registration.ts";
import { chromeStore, type KeyValueStore } from "../storage.ts";
import { h, show, statusLine } from "../ui/dom.ts";
import { store } from "../ui/state.ts";
import { backToListButton } from "./router.ts";

/** The switch was flipped: ask for the https permission, or give it up; the view is then drawn again. */
function onToggle(on: boolean, api: SaveWatchApi): void {
  if (on) {
    // Straight in the handler, before any await: the permission prompt needs the user gesture. Chrome may
    // close the popup for the prompt; the service worker registers the script on permissions.onAdded.
    chrome.permissions.request({ origins: [...SAVE_ORIGINS] }, () => {
      void chrome.runtime.lastError; // a refusal is fine: the switch is redrawn from the real state
      void saveSettingsView();
    });
    return;
  }
  void (async () => {
    await disableSavePrompt(api, (await store.getAccount())?.phoneUrls ?? []);
    await saveSettingsView();
  })();
}

/** The hosts the question never appears for, each with „Usuń”. */
function neverHosts(never: string[], local: KeyValueStore): HTMLElement {
  const remove = async (host: string) => {
    await removeFromNever(local, host);
    await saveSettingsView();
  };
  return h(
    "ul",
    { class: "never" },
    ...never.map((host) =>
      h(
        "li",
        { class: "row" },
        h("span", { class: "grow mono" }, host),
        h("button", { type: "button", class: "small", onclick: () => remove(host) }, "Usuń"),
      ),
    ),
  );
}

/** "Zapis" on the list: the switch (= the https permission) and the hosts the prompt never appears for. */
export async function saveSettingsView(): Promise<void> {
  const api = chromeSaveWatchApi();
  const local = chromeStore(chrome.storage.local);
  const [enabled, never] = await Promise.all([api.contains(["https://*/*"]), neverList(local)]);

  const toggle = h("input", { type: "checkbox" });
  toggle.checked = enabled;
  toggle.addEventListener("change", () => onToggle(toggle.checked, api));
  const hosts = never.length === 0 ? h("p", { class: "hint" }, "Brak") : neverHosts(never, local);

  show(
    h("h1", {}, "Zapis haseł"),
    h("label", { class: "check" }, toggle, "Pytaj o zapis haseł"),
    h(
      "p",
      { class: "hint" },
      "Po zalogowaniu na stronie wtyczka zapyta, czy zapisać login i hasło w PassHolder. Wymaga zgody Chrome na dostęp do stron.",
    ),
    h("h2", {}, "Nigdy dla tych stron"),
    hosts,
    h("div", { class: "actions" }, backToListButton()),
    statusLine(),
  );
}
