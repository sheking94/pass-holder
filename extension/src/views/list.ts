import { p2p } from "@passholder/core";
import { matchSavedLogins } from "../autofill/saved-logins.ts";
import { UNSUPPORTED_PAGE } from "../autofill/fill-tab.ts";
import { TYPE_INFO, entrySummary, matchesQuery } from "../entry-types.ts";
import { errorMessage } from "../error-messages.ts";
import { activeTab, requestFill } from "../ui/active-tab.ts";
import { copySecret, copyText } from "../ui/copy.ts";
import { busy, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { IN_TAB, openInTabButton } from "../ui/page.ts";
import { store } from "../ui/state.ts";
import type { FilesOutcome, StoredEntry } from "../vault-store.ts";
import { skippedNote } from "./notes.ts";
import { views, type ListOptions } from "./router.ts";

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

/**
 * The tab the list shows when listView() is called without a type. Module state on purpose: the popup page
 * lives as long as one visit, and every view that goes back to the list should land on the tab left.
 */
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

/** A copy button of a login row; a failure goes to the status line. */
function copyButton(
  label: string,
  title: string,
  copy: () => Promise<void>,
  status: HTMLElement,
): HTMLButtonElement {
  const onclick = () =>
    copy().catch((error: unknown) => setStatus(status, errorMessage(error), true));
  return h("button", { title, onclick }, label);
}

/** The button that opens the whole entry: icon, name (📎 with attachments, • when not synced) and summary. */
function openButton(e: StoredEntry) {
  const summary = entrySummary(e.data);
  const clips = e.data.attachments?.length ?? 0;
  return h(
    "button",
    {
      class: "entry-open grow",
      title: `Otwórz: ${e.data.name}`,
      onclick: () => views().edit(e.data.type, e.id),
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
}

/**
 * Where a row is shown. "list": a login gets its copy buttons, a card or contact „Wypełnij” (popup only).
 * "matches" (logins for the page under the popup): only „Wypełnij”.
 */
type RowPlace = "list" | "matches";

function entryRow(e: StoredEntry, status: HTMLElement, place: RowPlace) {
  const fillable =
    place === "matches" || (!IN_TAB && (e.data.type === "card" || e.data.type === "contact"));
  const fields = place === "list" && e.data.type === "login" ? e.data.fields : undefined;
  return h(
    "li",
    {},
    openButton(e),
    fields &&
      copyButton("Login", "Kopiuj login", () => copyText(fields.username, "login", status), status),
    fillable && fillButton(e, status),
    fields &&
      copyButton(
        "Hasło",
        "Kopiuj hasło",
        () => copySecret(fields.password, "hasło", status),
        status,
      ),
  );
}

/** The type tabs; markTab() shows which one is pressed. */
function typeTabs(select: (t: p2p.EntryType) => void) {
  const buttons = p2p.ENTRY_TYPES.map((t) =>
    h(
      "button",
      { type: "button", title: TYPE_INFO[t].tab, onclick: () => select(t) },
      h("span", { class: "icon", "aria-hidden": "true" }, TYPE_INFO[t].icon),
      h("span", {}, TYPE_INFO[t].tab),
    ),
  );
  const markTab = () =>
    buttons.forEach((b, i) =>
      b.setAttribute("aria-pressed", String(p2p.ENTRY_TYPES[i] === currentType)),
    );
  return {
    node: h("div", { class: "tabs", role: "group", "aria-label": "Typ wpisu" }, ...buttons),
    markTab,
  };
}

/** Logins matching the page the popup was opened over (Loginy tab only); filled in once the tab is known. */
function matchesSection(status: HTMLElement) {
  const node = h("div", { class: "matches" });
  node.hidden = true;
  const tab = activeTab().catch(() => undefined);
  const render = async () => {
    const page = currentType === "login" ? await tab : undefined;
    const rows = page ? matchSavedLogins(page.url, store.listEntries("login")) : [];
    // The tab may have changed while the tab query was pending.
    const shown = currentType === "login" ? rows : [];
    node.hidden = shown.length === 0;
    node.replaceChildren(
      ...(shown.length === 0
        ? []
        : [
            h("h2", {}, "Pasujące do tej strony"),
            h("ul", { class: "entries" }, ...shown.map((e) => entryRow(e, status, "matches"))),
          ]),
    );
  };
  return { node, render };
}

/** Syncs with the phone and says what happened (entries, skipped addresses, files). */
function sync(status: HTMLElement, refresh: () => void) {
  return busy(status, "Synchronizuję…", async () => {
    const result = await store.sync((done, total) =>
      setStatus(status, `Pliki: ${done} z ${total}`),
    );
    refresh();
    const note = filesNote(result.files);
    setStatus(
      status,
      `Zsynchronizowano z telefonem ${new Date().toLocaleTimeString("pl")}.` +
        skippedNote(result.skipped) +
        note.text,
      note.error,
    );
  });
}

/** The buttons under the list. */
function listActions(status: HTMLElement, refresh: () => void) {
  return h(
    "div",
    { class: "actions" },
    h("button", { onclick: () => sync(status, refresh) }, "Synchronizuj"),
    h("button", { title: "Logowanie PIN-em", onclick: () => void views().pinSettings() }, "PIN"),
    h(
      "button",
      { title: "Pytanie o zapis haseł", onclick: () => void views().saveSettings() },
      "Zapis",
    ),
    h(
      "button",
      {
        onclick: async () => {
          await store.lock();
          await views().locked();
        },
      },
      "Zablokuj",
    ),
    h(
      "button",
      {
        title: "Adresy telefonu (np. w domu i przez Tailscale), parowanie z innym telefonem",
        onclick: () => void views().addresses(),
      },
      "Adresy telefonu",
    ),
    h(
      "button",
      {
        title: "Import i eksport (PassHolder JSON, Bitwarden JSON, NordPass CSV)",
        onclick: () => void views().transfer(),
      },
      "Plik",
    ),
  );
}

/** The list of one entry type; without options.type, the tab chosen last (Loginy at first). */
export function listView({ message = "", error = false, type }: ListOptions = {}) {
  if (type) currentType = type;
  const search = h("input", { type: "search", placeholder: "Szukaj…" });
  const list = h("ul", { class: "entries" });
  const status = statusLine();
  setStatus(status, message, error);
  const matches = matchesSection(status);

  const renderList = () => {
    const query = search.value.trim();
    const rows = store
      .listEntries(currentType)
      .filter((e) => !query || matchesQuery(e.data, query));
    list.replaceChildren(
      ...(rows.length === 0
        ? [h("li", { class: "empty" }, query ? "Nic nie pasuje." : "Brak wpisów. Dodaj pierwszy.")]
        : rows.map((e) => entryRow(e, status, "list"))),
    );
  };
  const refresh = () => {
    renderList();
    void matches.render();
  };

  // A search phrase belongs to one tab: switching clears it.
  const tabs = typeTabs((t) => {
    currentType = t;
    search.value = "";
    tabs.markTab();
    refresh();
    search.focus();
  });
  tabs.markTab();
  search.addEventListener("input", renderList);

  show(
    openInTabButton(),
    tabs.node,
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, search),
      h("button", { class: "primary", onclick: () => views().edit(currentType) }, "+ Dodaj"),
    ),
    matches.node,
    list,
    listActions(status, refresh),
    status,
  );
  const pending = store.pendingCount();
  if (!message && pending > 0)
    setStatus(status, `Niezsynchronizowane zmiany: ${pending} (oznaczone •).`);
  refresh();
  search.focus();
}
