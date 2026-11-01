import { CLEAR_AFTER_MINUTES, sha256Hex, type ClipboardMessage } from "../clipboard.ts";
import { busy, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { openAddresses } from "./addresses.ts";
import { editView } from "./edit.ts";
import { showLocked } from "./locked.ts";
import { pinSettingsView } from "./pin-settings.ts";
import { openTransfer } from "./transfer.ts";

async function copyLogin(username: string, status: HTMLElement) {
  await navigator.clipboard.writeText(username);
  setStatus(status, "Skopiowano login.");
}

/** Copies the password and asks the service worker to clear the clipboard after a minute. */
async function copyPassword(password: string, status: HTMLElement) {
  await navigator.clipboard.writeText(password);
  const message: ClipboardMessage = { target: "background", type: "password-copied", hash: await sha256Hex(password) };
  await chrome.runtime.sendMessage(message);
  setStatus(status, `Skopiowano hasło. Schowek zostanie wyczyszczony za ${CLEAR_AFTER_MINUTES} min.`);
}

export function listView(message = "") {
  const search = h("input", { type: "search", placeholder: "Szukaj…" });
  const list = h("ul", { class: "entries" });
  const status = statusLine();
  setStatus(status, message);

  const renderList = () => {
    const query = search.value.trim().toLowerCase();
    const rows = store
      .entries()
      .filter((e) => !query || `${e.data.name} ${e.data.username}`.toLowerCase().includes(query))
      .sort((a, b) => a.data.name.localeCompare(b.data.name, "pl"));
    list.replaceChildren(
      ...(rows.length === 0
        ? [h("li", { class: "empty" }, query ? "Nic nie pasuje." : "Brak wpisów. Dodaj pierwszy.")]
        : rows.map((e) =>
            h(
              "li",
              {},
              h(
                "div",
                { class: "grow" },
                h("div", { class: "name", title: e.data.name }, e.data.name, e.dirty ? " •" : ""),
                h("div", { class: "user", title: e.data.username }, e.data.username),
              ),
              h("button", { title: "Kopiuj login", onclick: () => copyLogin(e.data.username, status) }, "Login"),
              h("button", { title: "Kopiuj hasło", onclick: () => copyPassword(e.data.password, status) }, "Hasło"),
              h("button", { title: "Edytuj", onclick: () => editView(e.id) }, "Edytuj"),
            ),
          )),
    );
  };
  search.addEventListener("input", renderList);

  show(
    openInTabButton(),
    h("div", { class: "row" }, h("div", { class: "grow" }, search), h("button", { class: "primary", onclick: () => editView() }, "+ Dodaj")),
    list,
    h(
      "div",
      { class: "actions" },
      h("button", {
        onclick: () =>
          busy(status, "Synchronizuję…", async () => {
            await store.sync();
            renderList();
            setStatus(status, `Zsynchronizowano ${new Date().toLocaleTimeString("pl")}.`);
          }),
      }, "Synchronizuj"),
      h("button", { title: "Logowanie PIN-em", onclick: () => void pinSettingsView() }, "PIN"),
      h("button", { onclick: async () => { await store.lock(); await showLocked(); } }, "Zablokuj"),
      h("button", { title: "Adresy serwera, np. w domu i przez Tailscale", onclick: () => void openAddresses() }, "Adresy serwera"),
      h("button", { title: "Import i eksport haseł w pliku CSV (format NordPass)", onclick: () => void openTransfer() }, "CSV"),
    ),
    status,
  );
  const pending = store.pendingCount();
  if (!message && pending > 0) setStatus(status, `Niezsynchronizowane zmiany: ${pending} (oznaczone •).`);
  renderList();
  search.focus();
}
