import { p2p } from "@passholder/core";
import { busy, form, h, passwordField, setStatus, show, statusLine } from "../ui/dom.ts";
import { IN_TAB, showInTab } from "../ui/page.ts";
import { pairingCodeField } from "../ui/pairing-code.ts";
import {
  originPattern,
  phoneUrlFields,
  requestOptionalHostPermission,
  submitPhoneUrls,
} from "../ui/phone-url-fields.ts";
import { store } from "../ui/state.ts";
import { MASTER_PASSWORD_LABEL } from "../ui/texts.ts";
import {
  pairingCancelledMessage,
  pairingExpiredMessage,
  PairedButSyncFailed,
  type PendingPairingInfo,
} from "../vault-store.ts";
import { skippedNote } from "./notes.ts";
import { views } from "./router.ts";

const PAIRED =
  "Sparowano z telefonem. Możesz zamknąć tę kartę i używać ikony PassHolder na pasku. Logowanie PIN-em włączysz przyciskiem PIN.";

/** "Chrome (Windows)", "Chrome (macOS)"…; the user can change it before pairing. */
function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
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
    h(
      "p",
      {},
      waiting
        ? "Parowanie czeka na hasło główne. Dokończ je w karcie ustawień."
        : "Wtyczka synchronizuje hasła z aplikacją PassHolder na telefonie. Parowanie ustawia się w osobnej karcie, bo Chrome zamyka to okienko, gdy pyta o zgodę na dostęp do telefonu.",
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { class: "primary", onclick: () => void showInTab("setup", connectView) },
        waiting ? "Dokończ parowanie" : "Sparuj z telefonem",
      ),
    ),
  );
}

/** The pairing waits for the master password: go straight there (the code is already spent). */
async function connectView(message = "") {
  const pending = await store.pendingPairing();
  if (pending) return passwordStep(pending);
  codeStep(message);
}

/** What to do on the phone before step 1. */
function pairingSteps() {
  return h(
    "ol",
    { class: "steps" },
    h(
      "li",
      {},
      "W aplikacji PassHolder na telefonie otwórz Synchronizacja i wybierz „Dodaj wtyczkę”.",
    ),
    h(
      "li",
      {},
      `Przepisz tu adres i ${p2p.PAIRING_CODE_LENGTH}-cyfrowy kod z ekranu telefonu. Kod jest ważny ${p2p.PAIRING_CODE_TTL_MS / 60_000} minuty i działa raz.`,
    ),
  );
}

/** Step 1: the phone's address and the one-time code from its "Synchronizacja" screen. */
function codeStep(message = "") {
  const addresses = phoneUrlFields();
  const code = pairingCodeField();
  const name = h("input", {
    type: "text",
    value: defaultDeviceName(),
    maxLength: p2p.MAX_DEVICE_NAME_LENGTH,
  });
  const status = statusLine();
  setStatus(status, message, Boolean(message));

  const submit = () =>
    submitPhoneUrls(addresses, status, "Łączę z telefonem…", async (urls) => {
      await store.pairStart(urls, code.input.value, name.value);
      const pending = await store.pendingPairing();
      if (!pending) return codeStep(pairingExpiredMessage(name.value.trim()));
      passwordStep(pending);
    });

  show(
    h("h1", {}, "PassHolder: sparuj z telefonem"),
    pairingSteps(),
    form(
      submit,
      ...addresses.fields,
      ...code.nodes,
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
function passwordStep(pending: PendingPairingInfo, message = "") {
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const status = statusLine();
  setStatus(status, message, Boolean(message));

  // Addresses the phone reported besides the typed one: asked here, on the click, as sync cannot ask later.
  // Once per screen: after a wrong password the next try should not show Chrome's prompt again.
  let asked = false;
  const askOnce = (then: () => void) => {
    if (asked) return then();
    asked = true;
    requestOptionalHostPermission([...new Set(pending.phoneUrls.map(originPattern))], then);
  };

  const submit = () =>
    askOnce(
      () => void busy(status, "Liczę klucze z hasła głównego…", () => finish(pending, password)),
    );

  show(
    h("h1", {}, "PassHolder: hasło główne"),
    h("p", { class: "ok" }, `Połączono z telefonem „${pending.phoneName}”.`),
    h(
      "p",
      {},
      "Wpisz hasło główne sejfu z telefonu. Jeśli się pomylisz, spróbuj jeszcze raz: nowy kod nie jest potrzebny.",
    ),
    form(
      submit,
      h("label", {}, MASTER_PASSWORD_LABEL),
      passwordField(password).row,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", class: "primary" }, "Odblokuj i synchronizuj"),
        cancelButton(pending),
      ),
    ),
    status,
  );
  password.focus();
}

/** Finishes the pairing with the typed master password and shows the list; a wrong password stays on step 2. */
async function finish(pending: PendingPairingInfo, password: HTMLInputElement): Promise<void> {
  try {
    const { skipped } = await store.pairFinish(password.value);
    views().list({ message: PAIRED + skippedNote(skipped) });
  } catch (error) {
    if (error instanceof PairedButSyncFailed)
      return views().list({ message: error.message, error: true });
    password.value = "";
    // The pairing is gone (expired, or cancelled in another tab): the phone still lists this browser.
    if (!(await store.hasPendingPairing()))
      return codeStep(pairingExpiredMessage(pending.deviceName));
    throw error;
  }
}

function cancelButton(pending: PendingPairingInfo) {
  return h(
    "button",
    {
      type: "button",
      onclick: async () => {
        // Also when it expired meanwhile: the phone lists the browser either way.
        codeStep(pairingCancelledMessage((await store.cancelPairing()) ?? pending.deviceName));
      },
    },
    "Anuluj parowanie",
  );
}
