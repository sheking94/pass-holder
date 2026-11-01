import {
  CHARACTER_GROUPS,
  DEFAULT_GENERATOR_OPTIONS,
  MAX_LENGTH,
  MIN_LENGTH,
  generatePassword,
  type CharacterGroup,
  type GeneratorOptions,
} from "@passholder/core";
import { CLEAR_AFTER_MINUTES, sha256Hex, type ClipboardMessage } from "./clipboard.ts";
import { exportNordPassCsv, parseNordPassCsv } from "./csv-transfer.ts";
import { chromeStore, STORAGE_KEYS, VaultStore } from "./vault-store.ts";

const app = document.getElementById("app")!;
const local = chromeStore(chrome.storage.local);
const store = new VaultStore(local, chromeStore(chrome.storage.session));

const MIN_MASTER_PASSWORD = 12;
const GROUP_LABELS: Record<CharacterGroup, string> = {
  lowercase: "małe litery",
  uppercase: "wielkie litery",
  digits: "cyfry",
  symbols: "symbole",
};

type Child = Node | string | false | undefined;

/** Small DOM helper: h("button", { class: "primary", onclick }, "Zapisz"). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el && key !== "list") (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

function show(...children: Child[]) {
  app.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)));
}

function statusLine() {
  return h("div", { class: "status", role: "status" });
}

function setStatus(el: HTMLElement, text: string, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}

/** Runs an async action with the buttons disabled and errors shown in the status line. */
async function busy(status: HTMLElement, message: string, action: () => Promise<void>) {
  const buttons = [...app.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  setStatus(status, message);
  try {
    await action();
  } catch (error) {
    setStatus(status, (error as Error).message, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function originPattern(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/** A password input with a button that shows or hides what was typed. */
function passwordField(input: HTMLInputElement) {
  const toggle = h("button", { type: "button", title: "Pokaż lub ukryj hasło" });
  const setVisible = (visible: boolean) => {
    input.type = visible ? "text" : "password";
    toggle.textContent = visible ? "Ukryj" : "Pokaż";
    toggle.setAttribute("aria-pressed", String(visible));
  };
  toggle.addEventListener("click", () => setVisible(input.type === "password"));
  setVisible(false);
  return { row: h("div", { class: "row" }, h("div", { class: "grow" }, input), toggle), setVisible };
}

/**
 * A form whose submit button (and Enter in any of its inputs) runs onSubmit.
 * Other buttons inside must have type "button", or Enter would click them too.
 */
function form(onSubmit: () => void, ...children: Child[]) {
  return h("form", {
    onsubmit: (event: Event) => {
      event.preventDefault();
      onSubmit();
    },
  }, ...children);
}

// --- Setup tab -----------------------------------------------------------------------------

/**
 * True when this page is open in a normal browser tab rather than in the toolbar popup.
 * Chrome closes the popup as soon as it shows the host permission prompt, so the code after
 * chrome.permissions.request never ran and the vault was never created. A tab stays open
 * while the prompt is shown, so connecting to the server always happens in a tab.
 */
const IN_TAB = new URLSearchParams(location.search).has("setup");

/** Opens the connect form in a tab and closes the popup. */
async function openSetupTab() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?setup") });
  window.close();
}

/** Shows the connect form here if this is the setup tab, otherwise moves it to a tab. */
function showConnect() {
  if (IN_TAB) return connectView();
  show(
    h("h1", {}, "PassHolder: połącz z serwerem"),
    h("p", {}, "Połączenie z serwerem ustawia się w osobnej karcie, bo Chrome zamyka to okienko, gdy pyta o zgodę na dostęp do serwera."),
    h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => void openSetupTab() }, "Otwórz ustawienia połączenia")),
  );
}

// --- Connect -------------------------------------------------------------------------------

function connectView(mode: "existing" | "new" = "existing") {
  const url = h("input", { type: "url", placeholder: "https://passholder.local:8443", required: true });
  const token = h("input", { type: "text", class: "mono", autocomplete: "off" });
  const isNew = mode === "new";
  const password = h("input", { type: "password", autocomplete: isNew ? "new-password" : "current-password" });
  const repeat = h("input", { type: "password", autocomplete: "new-password" });
  const status = statusLine();

  const submit = () => {
    const serverUrl = url.value.trim();
    let origin: string;
    try {
      origin = originPattern(serverUrl);
    } catch {
      return setStatus(status, "Podaj pełny adres, np. https://passholder.local:8443", true);
    }
    if (isNew && password.value.length < MIN_MASTER_PASSWORD) {
      return setStatus(status, `Hasło główne musi mieć co najmniej ${MIN_MASTER_PASSWORD} znaków`, true);
    }
    if (isNew && password.value !== repeat.value) return setStatus(status, "Hasła się różnią", true);
    // Must be called directly in the submit handler, before any await (it needs the user gesture).
    // This runs in a tab (see IN_TAB), so the page survives the prompt and the callback runs.
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      if (!granted) return setStatus(status, "Bez zgody na dostęp do serwera wtyczka nie może się z nim łączyć", true);
      void busy(status, "Liczę klucze z hasła głównego…", async () => {
        if (isNew) await store.createVault(serverUrl, token.value.trim(), password.value);
        else await store.connectExisting(serverUrl, password.value);
        listView("Połączono z serwerem. Możesz zamknąć tę kartę i używać ikony PassHolder na pasku.");
      });
    });
  };

  show(
    h("h1", {}, "PassHolder: połącz z serwerem"),
    h(
      "div",
      { class: "tabs" },
      h("button", { type: "button", "aria-pressed": String(!isNew), onclick: () => connectView("existing") }, "Mam już sejf"),
      h("button", { type: "button", "aria-pressed": String(isNew), onclick: () => connectView("new") }, "Nowy sejf"),
    ),
    form(
      submit,
      h("label", {}, "Adres serwera"),
      url,
      isNew && h("label", {}, "Token z logu serwera (jednorazowy)"),
      isNew && token,
      h("label", {}, "Hasło główne"),
      passwordField(password).row,
      isNew && h("label", {}, "Powtórz hasło główne"),
      isNew && passwordField(repeat).row,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, isNew ? "Załóż sejf" : "Połącz")),
    ),
    status,
  );
  url.focus();
}

// --- Locked --------------------------------------------------------------------------------

function lockedView() {
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const status = statusLine();
  const unlock = () =>
    busy(status, "Odblokowuję…", async () => {
      await store.unlock(password.value);
      if (TRANSFER_TAB) transferView();
      else listView();
    });

  let confirmDisconnect = false;
  const disconnect = h("button", {
    type: "button",
    class: "danger",
    onclick: async () => {
      if (!confirmDisconnect) {
        confirmDisconnect = true;
        disconnect.textContent = "Na pewno? Kliknij ponownie";
        return;
      }
      await store.disconnect();
      showConnect();
    },
  }, "Odłącz tę przeglądarkę");

  show(
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

// --- List ----------------------------------------------------------------------------------

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

function listView(message = "") {
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
      h("button", { onclick: async () => { await store.lock(); lockedView(); } }, "Zablokuj"),
      h("button", { title: "Import i eksport haseł w pliku CSV (format NordPass)", onclick: () => void openTransferTab() }, "CSV"),
    ),
    status,
  );
  const pending = store.pendingCount();
  if (!message && pending > 0) setStatus(status, `Niezsynchronizowane zmiany: ${pending} (oznaczone •).`);
  renderList();
  search.focus();
}

// --- Edit ----------------------------------------------------------------------------------

async function loadGeneratorOptions(): Promise<GeneratorOptions> {
  return (await local.get<GeneratorOptions>(STORAGE_KEYS.generator)) ?? DEFAULT_GENERATOR_OPTIONS;
}

async function editView(id?: string) {
  const data = id ? store.entry(id)?.data : undefined;
  const name = h("input", { type: "text", value: data?.name ?? "" });
  const username = h("input", { type: "text", value: data?.username ?? "", autocomplete: "off" });
  const password = h("input", { type: "password", class: "mono", value: data?.password ?? "", autocomplete: "off" });
  const passwordRow = passwordField(password);
  const status = statusLine();

  const options = await loadGeneratorOptions();
  const length = h("input", { type: "range", min: MIN_LENGTH, max: MAX_LENGTH, value: options.length });
  const lengthLabel = h("span", { class: "mono" }, String(options.length));
  length.addEventListener("input", () => (lengthLabel.textContent = length.value));
  const groupBoxes = (Object.keys(CHARACTER_GROUPS) as CharacterGroup[]).map((group) => ({
    group,
    box: h("input", { type: "checkbox", checked: options.groups.includes(group) }),
  }));

  const generate = async () => {
    const chosen: GeneratorOptions = {
      length: Number(length.value),
      groups: groupBoxes.filter((g) => g.box.checked).map((g) => g.group),
    };
    if (chosen.groups.length === 0) return setStatus(status, "Wybierz co najmniej jedną grupę znaków", true);
    password.value = generatePassword(chosen);
    passwordRow.setVisible(true);
    await local.set(STORAGE_KEYS.generator, chosen);
    setStatus(status, "");
  };

  const save = () =>
    busy(status, "Zapisuję…", async () => {
      if (!name.value.trim()) throw new Error("Podaj nazwę serwisu");
      if (!password.value) throw new Error("Podaj albo wygeneruj hasło");
      await store.upsert(id ?? crypto.randomUUID(), {
        name: name.value.trim(),
        username: username.value,
        password: password.value,
      });
      listView("Zapisano lokalnie. Zsynchronizuj, gdy serwer będzie włączony.");
    });

  let confirmDelete = false;
  const remove = h("button", {
    class: "danger",
    onclick: () => {
      if (!confirmDelete) {
        confirmDelete = true;
        remove.textContent = "Na pewno? Kliknij ponownie";
        return;
      }
      void busy(status, "Usuwam…", async () => {
        await store.delete(id!);
        listView("Usunięto lokalnie. Zsynchronizuj, żeby usunąć też na innych urządzeniach.");
      });
    },
  }, "Usuń");

  show(
    h("h1", {}, data ? "Edytuj wpis" : "Nowy wpis"),
    h("label", {}, "Nazwa serwisu"),
    name,
    h("label", {}, "Login"),
    username,
    h("label", {}, "Hasło"),
    passwordRow.row,
    h(
      "fieldset",
      {},
      h("legend", {}, "Generator haseł"),
      h("div", { class: "row" }, h("span", {}, "Długość"), length, lengthLabel),
      h(
        "div",
        { class: "groups" },
        ...groupBoxes.map(({ group, box }) => h("label", {}, box, GROUP_LABELS[group])),
      ),
      h("div", { class: "actions" }, h("button", { onclick: generate }, "Generuj")),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", onclick: save }, "Zapisz"),
      h("button", { onclick: () => listView() }, "Anuluj"),
      data && remove,
    ),
    status,
  );
  name.focus();
}

// --- CSV import and export ----------------------------------------------------------------

/**
 * True in the import/export tab. Chrome closes the toolbar popup when the file chooser opens,
 * so choosing a file to import only works in a normal tab.
 */
const TRANSFER_TAB = new URLSearchParams(location.search).has("transfer");

async function openTransferTab() {
  if (TRANSFER_TAB) return transferView();
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?transfer") });
  window.close();
}

/** Lets the browser save text as a file in the downloads folder (or ask where, per Chrome settings). */
function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = h("a", { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function transferView() {
  const status = statusLine();

  const understood = h("input", { type: "checkbox" });
  const exportButton = h("button", { type: "button", class: "danger" }, "Pobierz plik CSV");
  exportButton.addEventListener("click", () => {
    if (!understood.checked) return setStatus(status, "Najpierw zaznacz, że rozumiesz ryzyko.", true);
    const entries = store.entries().map((e) => e.data);
    downloadText(`passholder-${new Date().toISOString().slice(0, 10)}.csv`, exportNordPassCsv(entries));
    setStatus(status, `Wyeksportowano ${entries.length} wpisów. Usuń plik, gdy nie będzie już potrzebny.`);
  });

  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  const importButton = h("button", { type: "button", class: "primary" }, "Importuj");
  importButton.addEventListener("click", () => {
    const chosen = file.files?.[0];
    if (!chosen) return setStatus(status, "Wybierz plik CSV.", true);
    void busy(status, "Importuję…", async () => {
      const parsed = parseNordPassCsv(await chosen.text());
      const { added, duplicates } = await store.importEntries(parsed.entries);
      const lines = [
        `Dodano ${added} wpisów (lokalnie, zsynchronizuj, żeby trafiły na serwer).`,
        duplicates > 0 && `Pominięto ${duplicates} takich, które już są w sejfie.`,
        parsed.skipped.length > 0 &&
          `Pominięto ${parsed.skipped.length} wierszy: ` +
            parsed.skipped.slice(0, 5).map((s) => `wiersz ${s.line}: ${s.reason}`).join("; ") +
            (parsed.skipped.length > 5 ? "; …" : "."),
        "Usuń plik CSV z dysku, zawiera hasła jawnym tekstem.",
      ];
      setStatus(status, lines.filter(Boolean).join(" "));
      file.value = "";
    });
  });

  show(
    h("h1", {}, "Import i eksport CSV"),
    h("p", {}, "Format pliku jest taki sam jak w NordPass. PassHolder przenosi nazwę, login i hasło; pozostałe kolumny (adres, notatka, folder…) są przy eksporcie puste, a przy imporcie pomijane."),
    h(
      "fieldset",
      {},
      h("legend", {}, "Eksport"),
      h("p", { class: "warning" }, "Uwaga: plik CSV nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, synchronizacja folderu Pobrane z chmurą), pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu."),
      h("label", { class: "check" }, understood, "Rozumiem, plik będzie zawierał hasła jawnym tekstem"),
      h("div", { class: "actions" }, exportButton),
    ),
    h(
      "fieldset",
      {},
      h("legend", {}, "Import"),
      h("p", {}, "Wybierz plik wyeksportowany z NordPass (albo z PassHolder). Wpisy, które już są w sejfie z tą samą nazwą, loginem i hasłem, zostaną pominięte."),
      file,
      h("div", { class: "actions" }, importButton),
    ),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => listView() }, "Wróć do listy")),
    status,
  );
}

// --- Start ---------------------------------------------------------------------------------

async function start() {
  if (IN_TAB || TRANSFER_TAB) document.body.classList.add("tab");
  if (!(await store.getAccount())) return showConnect();
  if (await store.resume()) return TRANSFER_TAB ? transferView() : listView();
  lockedView();
}

void start();
