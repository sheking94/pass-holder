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
import { isValidPin, MAX_PIN_ATTEMPTS } from "./pin-lock.ts";
import { exportNordPassCsv, parseNordPassCsv } from "./csv-transfer.ts";
import { chromeTabApi, isTabPage, openInTab, SETUP_PARAM } from "./open-in-tab.ts";
import { normalizeServerUrls } from "./server-urls.ts";
import { chromeStore, STORAGE_KEYS, VaultStore, type PinStatus } from "./vault-store.ts";

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

const URL_EXAMPLE = "https://passholder.local:8443";
const SECOND_URL_EXAMPLE = "https://100.x.y.z:8443";

/** Two address inputs: the main one and an optional second one (e.g. Tailscale). The vault picks whichever answers. */
function serverUrlFields(current: readonly string[] = []) {
  const main = h("input", { type: "url", placeholder: URL_EXAMPLE, required: true, value: current[0] ?? "" });
  const second = h("input", { type: "url", placeholder: SECOND_URL_EXAMPLE, value: current[1] ?? "" });
  return {
    main,
    fields: [
      h("label", {}, "Adres serwera"),
      main,
      h("label", {}, "Drugi adres serwera (opcjonalnie, np. Tailscale)"),
      second,
    ],
    /** The typed addresses and the host permission patterns they need, or an error message. */
    read(): { urls: string[]; origins: string[] } | string {
      const urls = normalizeServerUrls([main.value, second.value]);
      if (urls.length === 0) return `Podaj pełny adres, np. ${URL_EXAMPLE}`;
      try {
        return { urls, origins: [...new Set(urls.map(originPattern))] };
      } catch {
        return `Podaj pełne adresy, np. ${URL_EXAMPLE}`;
      }
    },
  };
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
 * The "Otwórz w karcie" button (?tab) opens the whole extension in a tab for the same reason:
 * a click on the web page closes the popup and loses what was typed.
 */
const PARAMS = new URLSearchParams(location.search);
const IN_TAB = isTabPage(location.search) || PARAMS.has("addresses");

/** Opens the connect form in a tab and closes the popup. */
async function openSetupTab() {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?${SETUP_PARAM}`) });
  window.close();
}

/** Button shown only in the popup: switches to a PassHolder tab (opens one if needed). */
function openInTabButton() {
  if (IN_TAB || TRANSFER_TAB) return undefined;
  return h("div", { class: "topbar" }, h("button", {
    type: "button",
    class: "small",
    title: "Karta nie zamyka się po kliknięciu na stronie, więc wpisane dane nie znikają",
    onclick: async () => {
      await openInTab(chromeTabApi(), chrome.runtime.getURL("popup.html"));
      window.close();
    },
  }, "Otwórz w karcie ↗"));
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
  const addresses = serverUrlFields();
  const token = h("input", { type: "text", class: "mono", autocomplete: "off" });
  const isNew = mode === "new";
  const password = h("input", { type: "password", autocomplete: isNew ? "new-password" : "current-password" });
  const repeat = h("input", { type: "password", autocomplete: "new-password" });
  const status = statusLine();

  const submit = () => {
    const typed = addresses.read();
    if (typeof typed === "string") return setStatus(status, typed, true);
    if (isNew && password.value.length < MIN_MASTER_PASSWORD) {
      return setStatus(status, `Hasło główne musi mieć co najmniej ${MIN_MASTER_PASSWORD} znaków`, true);
    }
    if (isNew && password.value !== repeat.value) return setStatus(status, "Hasła się różnią", true);
    // Must be called directly in the submit handler, before any await (it needs the user gesture).
    // This runs in a tab (see IN_TAB), so the page survives the prompt and the callback runs.
    chrome.permissions.request({ origins: typed.origins }, (granted) => {
      if (!granted) return setStatus(status, "Bez zgody na dostęp do serwera wtyczka nie może się z nim łączyć", true);
      void busy(status, "Liczę klucze z hasła głównego…", async () => {
        if (isNew) await store.createVault(typed.urls, token.value.trim(), password.value);
        else await store.connectExisting(typed.urls, password.value);
        listView("Połączono z serwerem. Możesz zamknąć tę kartę i używać ikony PassHolder na pasku. Logowanie PIN-em włączysz przyciskiem PIN.");
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
      ...addresses.fields,
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
  addresses.main.focus();
}

// --- Server addresses ----------------------------------------------------------------------

/** Opens the address form in a tab: like connecting, it may need a host permission prompt. */
async function openAddressesTab() {
  // Already in a tab (also the "Otwórz w karcie" one): the prompt cannot close it, so show the form here.
  if (IN_TAB) return addressesView();
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?addresses") });
  window.close();
}

/** Changes the server addresses of an already connected browser, without connecting again. */
async function addressesView() {
  const account = await store.getAccount();
  if (!account) return showConnect();
  const addresses = serverUrlFields(account.serverUrls);
  const status = statusLine();

  const submit = () => {
    const typed = addresses.read();
    if (typeof typed === "string") return setStatus(status, typed, true);
    // Before any await, like in connectView: the prompt needs the user gesture.
    chrome.permissions.request({ origins: typed.origins }, (granted) => {
      if (!granted) return setStatus(status, "Bez zgody na dostęp do serwera wtyczka nie może się z nim łączyć", true);
      void busy(status, "Zapisuję…", async () => {
        await store.setServerUrls(typed.urls);
        setStatus(status, "Zapisano. Przy synchronizacji wtyczka sama wybierze adres, który odpowiada." + (PARAMS.has("addresses") ? " Możesz zamknąć tę kartę." : ""));
      });
    });
  };

  show(
    h("h1", {}, "PassHolder: adresy serwera"),
    h("p", {}, "Podaj adresy, pod którymi łączysz się z tym samym serwerem, np. w sieci domowej i w Tailscale. Każdy z nich musi być w certyfikacie serwera."),
    form(
      submit,
      ...addresses.fields,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", class: "primary" }, "Zapisz"),
        // Opened from the list in this tab (not the separate ?addresses tab), so there is a list to go back to.
        !PARAMS.has("addresses") && h("button", { type: "button", onclick: () => listView() }, "Wróć do listy"),
      ),
    ),
    status,
  );
  addresses.main.focus();
}

// --- Locked --------------------------------------------------------------------------------

/** The PIN screen when the PIN is on, otherwise the master password screen. */
async function showLocked() {
  const pin = await store.pinStatus();
  if (pin) pinLockedView(pin);
  else lockedView();
}

function pinInput(autocomplete = "off") {
  return h("input", { type: "password", inputmode: "numeric", pattern: "[0-9]{4,6}", maxlength: 6, autocomplete, class: "mono" });
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
      if (TRANSFER_TAB) transferView();
      else listView();
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
      h("button", { title: "Adresy serwera, np. w domu i przez Tailscale", onclick: () => void openAddressesTab() }, "Adresy serwera"),
      h("button", { title: "Import i eksport haseł w pliku CSV (format NordPass)", onclick: () => void openTransferTab() }, "CSV"),
    ),
    status,
  );
  const pending = store.pendingCount();
  if (!message && pending > 0) setStatus(status, `Niezsynchronizowane zmiany: ${pending} (oznaczone •).`);
  renderList();
  search.focus();
}

// --- PIN settings --------------------------------------------------------------------------

async function pinSettingsView() {
  const current = await store.pinStatus();
  const status = statusLine();
  const back = h("button", { type: "button", onclick: () => listView() }, "Wróć");

  if (current) {
    show(
      h("h1", {}, "Logowanie PIN-em"),
      h("p", {}, "PIN jest włączony. ", current.rememberedAfterRestart
        ? "Działa też po ponownym uruchomieniu przeglądarki."
        : "Po zamknięciu przeglądarki trzeba będzie raz podać hasło główne."),
      h(
        "div",
        { class: "actions" },
        h("button", {
          class: "danger",
          onclick: async () => {
            await store.disablePin();
            listView("PIN wyłączony. Do odblokowania potrzebne będzie hasło główne.");
          },
        }, "Wyłącz PIN"),
        back,
      ),
      status,
    );
    return;
  }

  const pin = pinInput("new-password");
  const repeat = pinInput("new-password");
  const remember = h("input", { type: "checkbox" });
  const submit = () => {
    if (!isValidPin(pin.value)) return setStatus(status, "PIN musi mieć od 4 do 6 cyfr", true);
    if (pin.value !== repeat.value) return setStatus(status, "PIN-y się różnią", true);
    void busy(status, "Liczę klucz z PIN-u…", async () => {
      await store.enablePin(pin.value, remember.checked);
      listView("PIN włączony. Użyjesz go po zablokowaniu sejfu.");
    });
  };

  show(
    h("h1", {}, "Włącz logowanie PIN-em"),
    h("p", { class: "hint" },
      `PIN odblokowuje sejf tylko w tej przeglądarce. Hasło główne dalej działa. Po ${MAX_PIN_ATTEMPTS} błędnych PIN-ach z rzędu PIN zostanie wyłączony.`),
    form(
      submit,
      h("label", {}, "PIN (4-6 cyfr)"),
      passwordField(pin).row,
      h("label", {}, "Powtórz PIN"),
      passwordField(repeat).row,
      h("label", { class: "check" }, remember, "Pamiętaj PIN po zamknięciu przeglądarki"),
      h("p", { class: "hint" },
        "Bez tej opcji PIN jest tylko w pamięci przeglądarki. Z nią trafia na dysk, a ktoś z kopią profilu Chrome może odgadnąć krótki PIN w kilka minut do kilku godzin."),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Włącz PIN"), back),
    ),
    status,
  );
  pin.focus();
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
    openInTabButton(),
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
const TRANSFER_TAB = PARAMS.has("transfer");

async function openTransferTab() {
  // Already in a tab (also the "Otwórz w karcie" one): the file chooser works here, no new tab needed.
  if (TRANSFER_TAB || IN_TAB) return transferView();
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
  if (PARAMS.has("addresses")) return addressesView();
  if (await store.resume()) return TRANSFER_TAB ? transferView() : listView();
  await showLocked();
}

void start();
