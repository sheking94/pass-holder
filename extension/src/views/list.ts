import type { p2p } from "@passholder/core";
import { ENTRY_TYPES, TYPE_INFO, entrySummary, matchesQuery } from "../entry-types.ts";
import type { StoredEntry } from "../vault-store.ts";
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

/** The tab the list shows when listView() is called without a type. */
let currentType: p2p.EntryType = "login";

/** One row: the whole entry opens on click; a login also gets its copy buttons. */
function entryRow(e: StoredEntry, status: HTMLElement) {
  const summary = entrySummary(e.data);
  const open = h(
    "button",
    { class: "entry-open grow", title: `Otwórz: ${e.data.name}`, onclick: () => editView(e.data.type, e.id) },
    h("span", { class: "icon", "aria-hidden": "true" }, TYPE_INFO[e.data.type].icon),
    h(
      "span",
      { class: "text" },
      h("span", { class: "name" }, e.data.name, e.dirty ? " •" : ""),
      h("span", { class: "user", title: summary }, summary),
    ),
  );
  const fields = e.data.type === "login" ? e.data.fields : undefined;
  return h(
    "li",
    {},
    open,
    fields && h("button", { title: "Kopiuj login", onclick: () => copyText(fields.username, "login", status).catch((err: Error) => setStatus(status, err.message, true)) }, "Login"),
    fields && h("button", { title: "Kopiuj hasło", onclick: () => copySecret(fields.password, "hasło", status).catch((err: Error) => setStatus(status, err.message, true)) }, "Hasło"),
  );
}

/** The list of one entry type; without type, the tab chosen last (Loginy at first). */
export function listView(message = "", isError = false, type?: p2p.EntryType) {
  if (type) currentType = type;
  const search = h("input", { type: "search", placeholder: "Szukaj…" });
  const list = h("ul", { class: "entries" });
  const status = statusLine();
  setStatus(status, message, isError);

  const tabButtons = ENTRY_TYPES.map((t) =>
    h(
      "button",
      { type: "button", title: TYPE_INFO[t].tab, onclick: () => selectTab(t) },
      h("span", { class: "icon", "aria-hidden": "true" }, TYPE_INFO[t].icon),
      h("span", {}, TYPE_INFO[t].tab),
    ),
  );
  const markTab = () =>
    tabButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(ENTRY_TYPES[i] === currentType)));

  const renderList = () => {
    const query = search.value.trim();
    const rows = store.listEntries(currentType).filter((e) => !query || matchesQuery(e.data, query));
    list.replaceChildren(
      ...(rows.length === 0
        ? [h("li", { class: "empty" }, query ? "Nic nie pasuje." : "Brak wpisów. Dodaj pierwszy.")]
        : rows.map((e) => entryRow(e, status))),
    );
  };

  // A search phrase belongs to one tab: switching clears it.
  const selectTab = (t: p2p.EntryType) => {
    currentType = t;
    search.value = "";
    markTab();
    renderList();
    search.focus();
  };
  markTab();

  search.addEventListener("input", renderList);

  show(
    openInTabButton(),
    h("div", { class: "tabs", role: "group", "aria-label": "Typ wpisu" }, ...tabButtons),
    h("div", { class: "row" }, h("div", { class: "grow" }, search), h("button", { class: "primary", onclick: () => editView(currentType) }, "+ Dodaj")),
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
