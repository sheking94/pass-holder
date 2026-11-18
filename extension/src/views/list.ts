import { errorMessage } from "../error-messages.ts";
import { autofill, p2p } from "@passholder/core";
import { TYPE_INFO, entrySummary, matchesQuery } from "../entry-types.ts";
import { UNSUPPORTED_PAGE } from "../autofill/fill-tab.ts";
import type { FilesOutcome, StoredEntry } from "../vault-store.ts";
import { copySecret, copyText } from "../ui/copy.ts";
import { busy, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { activeTab, requestFill } from "../ui/active-tab.ts";
import { IN_TAB, openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import { openAddresses } from "./addresses.ts";
import { editView } from "./edit.ts";
import { showLocked } from "./locked.ts";
import { pinSettingsView } from "./pin-settings.ts";
import { saveSettingsView } from "./save-settings.ts";
import { openTransfer } from "./transfer.ts";

/** One sentence about addresses a sync skipped because Chrome does not allow them yet; "" when none. */
export function skippedNote(skipped: readonly string[]): string {
  if (skipped.length === 0) return "";
  return ` Pominięto adresy bez zgody Chrome: ${skipped.join(", ")}. Zgodę dasz w „Adresy telefonu” (Zapisz).`;
}

/**
 * Sentences about the file phase of a sync ("" when nothing happened); error is true when it failed or found
 * corrupted files, so the status line shows as an error.
 */
export function filesNote(f: FilesOutcome): { text: string; error: boolean } {
  let text = "";
  if (f.uploaded + f.downloaded > 0)
    text += ` Pliki: wysłano ${f.uploaded}, pobrano ${f.downloaded}.`;
  if (f.pending > 0) text += ` Nie wszystkie pliki zsynchronizowane (${f.pending} czeka).`;
  if (f.error) text += ` Nie wszystkie pliki zsynchronizowane: ${f.error}.`;
  if (f.corrupted.length > 0)
    text += ` Uszkodzone pliki: ${f.corrupted.map((c) => c.name).join(", ")}.`;
  return { text, error: Boolean(f.error) || f.corrupted.length > 0 };
}

/** The tab the list shows when listView() is called without a type. */
let currentType: p2p.EntryType = "login";

/** Fills the entry into the active tab and closes the popup; a failure stays in the status line. */
function fillEntry(entryId: string, status: HTMLElement) {
  return busy(status, "Wypełniam…", async () => {
    const tab = await activeTab();
    if (!tab) return setStatus(status, UNSUPPORTED_PAGE, true);
    const result = await requestFill(tab.id, entryId);
    if (!result.ok) return setStatus(status, result.error, true);
    window.close();
  });
}

function fillButton(e: StoredEntry, status: HTMLElement) {
  return h(
    "button",
    { title: `Wypełnij: ${e.data.name}`, onclick: () => void fillEntry(e.id, status) },
    "Wypełnij",
  );
}

/** One row: the whole entry opens on click; a login also gets its copy buttons (unless copyable is false, as in the matches section), a card or contact „Wypełnij” (popup only). */
function entryRow(
  e: StoredEntry,
  status: HTMLElement,
  fillable = !IN_TAB && (e.data.type === "card" || e.data.type === "contact"),
  copyable = true,
) {
  const summary = entrySummary(e.data);
  const clips = e.data.attachments?.length ?? 0;
  const open = h(
    "button",
    {
      class: "entry-open grow",
      title: `Otwórz: ${e.data.name}`,
      onclick: () => editView(e.data.type, e.id),
    },
    h("span", { class: "icon", "aria-hidden": "true" }, TYPE_INFO[e.data.type].icon),
    h(
      "span",
      { class: "text" },
      h(
        "span",
        { class: "name" },
        e.data.name,
        clips > 0 && h("span", { class: "clip", title: `Załączniki: ${clips}` }, ` 📎 ${clips}`),
        e.dirty ? " •" : "",
      ),
      h("span", { class: "user", title: summary }, summary),
    ),
  );
  const fields = copyable && e.data.type === "login" ? e.data.fields : undefined;
  return h(
    "li",
    {},
    open,
    fields &&
      h(
        "button",
        {
          title: "Kopiuj login",
          onclick: () =>
            copyText(fields.username, "login", status).catch((error: unknown) =>
              setStatus(status, errorMessage(error), true),
            ),
        },
        "Login",
      ),
    fillable && fillButton(e, status),
    fields &&
      h(
        "button",
        {
          title: "Kopiuj hasło",
          onclick: () =>
            copySecret(fields.password, "hasło", status).catch((error: unknown) =>
              setStatus(status, errorMessage(error), true),
            ),
        },
        "Hasło",
      ),
  );
}

/** The list of one entry type; without type, the tab chosen last (Loginy at first). */
export function listView(message = "", isError = false, type?: p2p.EntryType) {
  if (type) currentType = type;
  const search = h("input", { type: "search", placeholder: "Szukaj…" });
  const list = h("ul", { class: "entries" });
  const status = statusLine();
  setStatus(status, message, isError);

  const tabButtons = p2p.ENTRY_TYPES.map((t) =>
    h(
      "button",
      { type: "button", title: TYPE_INFO[t].tab, onclick: () => selectTab(t) },
      h("span", { class: "icon", "aria-hidden": "true" }, TYPE_INFO[t].icon),
      h("span", {}, TYPE_INFO[t].tab),
    ),
  );
  const markTab = () =>
    tabButtons.forEach((b, i) =>
      b.setAttribute("aria-pressed", String(p2p.ENTRY_TYPES[i] === currentType)),
    );

  // Logins matching the page the popup was opened over (Loginy tab only); filled in once the tab is known.
  const matches = h("div", { class: "matches" });
  matches.hidden = true;
  const tab = activeTab().catch(() => undefined);
  const renderMatches = async () => {
    const page = currentType === "login" ? await tab : undefined;
    const rows = page
      ? autofill.matchLogins(page.url, store.listEntries("login"), (e) => ({
          name: e.data.name,
          urls: e.data.type === "login" ? e.data.fields.urls : [],
        }))
      : [];
    // The tab may have changed while the tab query was pending.
    const shown = currentType === "login" ? rows : [];
    matches.hidden = shown.length === 0;
    matches.replaceChildren(
      ...(shown.length === 0
        ? []
        : [
            h("h2", {}, "Pasujące do tej strony"),
            h("ul", { class: "entries" }, ...shown.map((e) => entryRow(e, status, true, false))),
          ]),
    );
  };

  const renderList = () => {
    const query = search.value.trim();
    const rows = store
      .listEntries(currentType)
      .filter((e) => !query || matchesQuery(e.data, query));
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
    void renderMatches();
    search.focus();
  };
  markTab();

  search.addEventListener("input", renderList);

  show(
    openInTabButton(),
    h("div", { class: "tabs", role: "group", "aria-label": "Typ wpisu" }, ...tabButtons),
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, search),
      h("button", { class: "primary", onclick: () => editView(currentType) }, "+ Dodaj"),
    ),
    matches,
    list,
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          onclick: () =>
            busy(status, "Synchronizuję…", async () => {
              const result = await store.sync((done, total) =>
                setStatus(status, `Pliki: ${done} z ${total}`),
              );
              renderList();
              void renderMatches();
              const note = filesNote(result.files);
              setStatus(
                status,
                `Zsynchronizowano z telefonem ${new Date().toLocaleTimeString("pl")}.` +
                  skippedNote(result.skipped) +
                  note.text,
                note.error,
              );
            }),
        },
        "Synchronizuj",
      ),
      h("button", { title: "Logowanie PIN-em", onclick: () => void pinSettingsView() }, "PIN"),
      h(
        "button",
        { title: "Pytanie o zapis haseł", onclick: () => void saveSettingsView() },
        "Zapis",
      ),
      h(
        "button",
        {
          onclick: async () => {
            await store.lock();
            await showLocked();
          },
        },
        "Zablokuj",
      ),
      h(
        "button",
        {
          title: "Adresy telefonu (np. w domu i przez Tailscale), parowanie z innym telefonem",
          onclick: () => void openAddresses(),
        },
        "Adresy telefonu",
      ),
      h(
        "button",
        {
          title: "Import i eksport (PassHolder JSON, Bitwarden JSON, NordPass CSV)",
          onclick: () => void openTransfer(),
        },
        "Plik",
      ),
    ),
    status,
  );
  const pending = store.pendingCount();
  if (!message && pending > 0)
    setStatus(status, `Niezsynchronizowane zmiany: ${pending} (oznaczone •).`);
  renderList();
  void renderMatches();
  search.focus();
}
