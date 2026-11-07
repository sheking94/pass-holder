import { busy, form, h, passwordField, setStatus, show, statusLine } from "../ui/dom.ts";
import { IN_TAB, showInTab } from "../ui/page.ts";
import { originPattern, requestHostPermission, requestOptionalHostPermission, serverUrlFields } from "../ui/server-url-fields.ts";
import { store } from "../ui/state.ts";
import { PairedButSyncFailed } from "../vault-store.ts";
import { listView, skippedNote } from "./list.ts";

const PAIRED =
  "Sparowano z telefonem. Możesz zamknąć tę kartę i używać ikony PassHolder na pasku. Logowanie PIN-em włączysz przyciskiem PIN.";

/** "Chrome (Windows)", "Chrome (macOS)"…; the user can change it before pairing. */
function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return `Chrome (${platform || "komputer"})`;
}

/**
 * Shows the pairing form here if this is a tab, otherwise moves it to the ?setup tab.
 * Chrome closes the popup as soon as it shows the host permission prompt, so the code after
 * chrome.permissions.request never ran there and the pairing was never saved.
 */
export async function showConnect() {
  if (IN_TAB) return connectView();
  const waiting = await store.hasPendingPairing();
  show(
    h("h1", {}, "PassHolder: sparuj z telefonem"),
    h("p", {}, waiting
      ? "Parowanie czeka na hasło główne. Dokończ je w karcie ustawień."
      : "Wtyczka synchronizuje hasła z aplikacją PassHolder na telefonie. Parowanie ustawia się w osobnej karcie, bo Chrome zamyka to okienko, gdy pyta o zgodę na dostęp do telefonu."),
    h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => void showInTab("setup", connectView) }, waiting ? "Dokończ parowanie" : "Sparuj z telefonem")),
  );
}

/** The pairing waits for the master password: go straight there (the code is already spent). */
async function connectView(message = "") {
  if (await store.hasPendingPairing()) return passwordStep();
  codeStep(message);
}

/** Step 1: the phone's address and the one-time code from its "Synchronizacja" screen. */
function codeStep(message = "") {
  const addresses = serverUrlFields();
  const code = h("input", { type: "text", class: "mono", inputmode: "numeric", autocomplete: "off", maxLength: 9, placeholder: "12345678" });
  const name = h("input", { type: "text", value: defaultDeviceName(), maxLength: 64 });
  const status = statusLine();
  setStatus(status, message, Boolean(message));

  const submit = () => {
    const typed = addresses.read();
    if (typeof typed === "string") return setStatus(status, typed, true);
    requestHostPermission(typed.origins, status, () => {
      void busy(status, "Łączę z telefonem…", async () => {
        await store.pairStart(typed.urls, code.value, name.value);
        await passwordStep();
      });
    });
  };

  show(
    h("h1", {}, "PassHolder: sparuj z telefonem"),
    h("ol", { class: "steps" },
      h("li", {}, "W aplikacji PassHolder na telefonie otwórz Synchronizacja i wybierz „Dodaj wtyczkę”."),
      h("li", {}, "Przepisz tu adres i 8-cyfrowy kod z ekranu telefonu. Kod jest ważny 2 minuty i działa raz."),
    ),
    form(
      submit,
      ...addresses.fields,
      h("label", {}, "Kod parowania (8 cyfr)"),
      code,
      h("label", {}, "Nazwa tej przeglądarki (zobaczysz ją w telefonie)"),
      name,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Sparuj")),
    ),
    status,
  );
  addresses.main.focus();
}

/**
 * Step 2: the master password of the phone's vault. A wrong one keeps the pairing (no new code is needed),
 * also after closing the tab, for 10 minutes. "Anuluj parowanie" drops it.
 */
async function passwordStep(message = "") {
  const pending = await store.pendingPairing();
  if (!pending) return codeStep("Parowanie wygasło. Poproś telefon o nowy kod.");
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const status = statusLine();
  setStatus(status, message, Boolean(message));

  const submit = () => {
    // Addresses the phone reported besides the typed one: asked here, on the click, as sync cannot ask later.
    requestOptionalHostPermission([...new Set(pending.phoneUrls.map(originPattern))], () => {
      void busy(status, "Liczę klucze z hasła głównego…", async () => {
        try {
          const { skipped } = await store.pairFinish(password.value);
          listView(PAIRED + skippedNote(skipped));
        } catch (error) {
          if (error instanceof PairedButSyncFailed) return listView(error.message, true);
          password.value = "";
          if (!(await store.hasPendingPairing())) return codeStep((error as Error).message);
          throw error;
        }
      });
    });
  };

  const cancel = h("button", {
    type: "button",
    onclick: async () => {
      await store.cancelPairing();
      codeStep();
    },
  }, "Anuluj parowanie");

  show(
    h("h1", {}, "PassHolder: hasło główne"),
    h("p", { class: "ok" }, `Połączono z telefonem „${pending.phoneName}”.`),
    h("p", {}, "Wpisz hasło główne sejfu z telefonu. Jeśli się pomylisz, spróbuj jeszcze raz: nowy kod nie jest potrzebny."),
    form(
      submit,
      h("label", {}, "Hasło główne"),
      passwordField(password).row,
      h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Odblokuj i synchronizuj"), cancel),
    ),
    status,
  );
  password.focus();
}
