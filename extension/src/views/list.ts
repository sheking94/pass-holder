import { copySecret, copyText } from "../ui/copy.ts";
import { busy, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { openAddresses } from "./addresses.ts";
import { editView } from "./edit.ts";
import { showLocked } from "./locked.ts";
import { pinSettingsView } from "./pin-settings.ts";
import { openTransfer } from "./transfer.ts";

/** One sentence about addresses a sync skipped because Chrome does not allow them yet; "" when none. */
export function skippedNote(skipped: readonly string[]): string {
  if (skipped.length === 0) return "";
  return ` Pominięto adresy bez zgody Chrome: ${skipped.join(", ")}. Zgodę dasz w „Adresy telefonu” (Zapisz).`;
}

export function listView(message = "", isError = false) {
  const search = h("input", { type: "search", placeholder: "Szukaj…" });
  const list = h("ul", { class: "entries" });
  const status = statusLine();
  setStatus(status, message, isError);

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
              h("button", { title: "Kopiuj login", onclick: () => copyText(e.data.username, "login", status) }, "Login"),
              h("button", { title: "Kopiuj hasło", onclick: () => copySecret(e.data.password, "hasło", status) }, "Hasło"),
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
            const { skipped } = await store.sync();
            renderList();
            setStatus(status, `Zsynchronizowano z telefonem ${new Date().toLocaleTimeString("pl")}.` + skippedNote(skipped));
          }),
      }, "Synchronizuj"),
      h("button", { title: "Logowanie PIN-em", onclick: () => void pinSettingsView() }, "PIN"),
      h("button", { onclick: async () => { await store.lock(); await showLocked(); } }, "Zablokuj"),
      h("button", { title: "Adresy telefonu (np. w domu i przez Tailscale), parowanie z innym telefonem", onclick: () => void openAddresses() }, "Adresy telefonu"),
      h("button", { title: "Import i eksport haseł w pliku CSV (format NordPass)", onclick: () => void openTransfer() }, "CSV"),
    ),
    status,
  );
  const pending = store.pendingCount();
  if (!message && pending > 0) setStatus(status, `Niezsynchronizowane zmiany: ${pending} (oznaczone •).`);
  renderList();
  search.focus();
}
