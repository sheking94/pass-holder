import { neverList, removeFromNever } from "../save/candidates.ts";
import { chromeSaveWatchApi, disableSavePrompt, SAVE_ORIGINS } from "../save/registration.ts";
import { chromeStore } from "../storage.ts";
import { h, show, statusLine } from "../ui/dom.ts";
import { store } from "../ui/state.ts";
import { listView } from "./list.ts";

/** "Zapis" on the list: the switch (= the https permission) and the hosts the prompt never appears for. */
export async function saveSettingsView(): Promise<void> {
  const api = chromeSaveWatchApi();
  const local = chromeStore(chrome.storage.local);
  const [enabled, never] = await Promise.all([api.contains(["https://*/*"]), neverList(local)]);

  const toggle = h("input", { type: "checkbox" });
  toggle.checked = enabled;
  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      // Straight in the handler, before any await: the permission prompt needs the user gesture. Chrome may
      // close the popup for the prompt; the service worker registers the script on permissions.onAdded.
      chrome.permissions.request({ origins: [...SAVE_ORIGINS] }, () => {
        void chrome.runtime.lastError; // a refusal is fine: the switch is redrawn from the real state
        void saveSettingsView();
      });
    } else {
      void (async () => {
        await disableSavePrompt(api, (await store.getAccount())?.phoneUrls ?? []);
        await saveSettingsView();
      })();
    }
  });

  const hosts =
    never.length === 0
      ? h("p", { class: "hint" }, "Brak")
      : h(
          "ul",
          { class: "never" },
          ...never.map((host) =>
            h(
              "li",
              { class: "row" },
              h("span", { class: "grow mono" }, host),
              h(
                "button",
                {
                  type: "button",
                  class: "small",
                  onclick: async () => {
                    await removeFromNever(local, host);
                    await saveSettingsView();
                  },
                },
                "Usuń",
              ),
            ),
          ),
        );

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
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", onclick: () => listView() }, "Wróć"),
    ),
    statusLine(),
  );
}
