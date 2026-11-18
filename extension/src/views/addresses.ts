import { form, h, passwordField, setStatus, show, statusLine } from "../ui/dom.ts";
import { MODE, showInTab } from "../ui/page.ts";
import { pairingCodeField } from "../ui/pairing-code.ts";
import { phoneUrlFields, submitPhoneUrls } from "../ui/phone-url-fields.ts";
import { store } from "../ui/state.ts";
import { MASTER_PASSWORD_LABEL } from "../ui/texts.ts";
import { PairedButSyncFailed, type Account } from "../vault-store.ts";
import { skippedNote } from "./notes.ts";
import { backToListButton, views } from "./router.ts";

const REPAIRED: Record<"paired" | "restored", string> = {
  paired: "Sparowano z telefonem. Ta przeglądarka synchronizuje się teraz z nim.",
  restored:
    "Telefon odtworzony z tej wtyczki: ma już wszystkie hasła. Synchronizacja działa jak dotąd.",
};

/** Opens the address form in a tab: like pairing, it may need a host permission prompt. */
export function openAddresses() {
  return showInTab("addresses", addressesView);
}

/**
 * The phone's addresses of an already paired browser (no new pairing needed: the Noise handshake checks the
 * phone's key on every sync), and "Sparuj z innym telefonem / odtwórz telefon".
 */
async function addressesView(message = "") {
  const account = await store.getAccount();
  if (!account) return views().connect();
  // The separate ?addresses tab has no list to go back to; it can just be closed.
  const ownTab = MODE === "addresses";
  const closeHint = ownTab ? " Możesz zamknąć tę kartę." : "";
  const addresses = addressesSection(account, message, ownTab, closeHint);
  show(
    h("h1", {}, "PassHolder: telefon"),
    h("p", {}, `Sparowano jako „${account.deviceName}” z telefonem „${account.phone.name}”.`),
    ...addresses.nodes,
    repairSection(closeHint),
  );
  addresses.focus();
}

/** The saved addresses and „Zapisz”. */
function addressesSection(account: Account, message: string, ownTab: boolean, closeHint: string) {
  const addresses = phoneUrlFields(account.phoneUrls);
  const status = statusLine();
  setStatus(status, message);
  const save = () =>
    submitPhoneUrls(addresses, status, "Zapisuję…", async (urls) => {
      await store.setPhoneUrls(urls);
      setStatus(
        status,
        "Zapisano. Przy synchronizacji wtyczka sama wybierze adres, który odpowiada." + closeHint,
      );
    });

  const nodes = [
    h(
      "p",
      {},
      "Adresy telefonu, np. w sieci domowej i w Tailscale. Telefon pokazuje je na ekranie Synchronizacja; te, które poda sam, wtyczka dopisuje przy synchronizacji.",
    ),
    form(
      save,
      ...addresses.fields,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", class: "primary" }, "Zapisz"),
        !ownTab && backToListButton("Wróć do listy"),
      ),
    ),
    status,
  ];
  return { nodes, focus: () => addresses.main.focus() };
}

/** „Sparuj z innym telefonem / odtwórz telefon”: a new pairing that keeps this browser's vault. */
function repairSection(closeHint: string) {
  const other = phoneUrlFields();
  const code = pairingCodeField();
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const status = statusLine();
  const repair = () =>
    submitPhoneUrls(other, status, "Paruję z telefonem…", async (urls) => {
      let done: string;
      try {
        const { mode, skipped } = await store.repair(urls, code.input.value, password.value);
        done = REPAIRED[mode] + skippedNote(skipped);
      } catch (error) {
        password.value = "";
        if (!(error instanceof PairedButSyncFailed)) throw error;
        done = error.message;
      }
      // The account now has the new phone's addresses: show them.
      await addressesView(done + closeHint);
    });

  return h(
    "fieldset",
    {},
    h("legend", {}, "Sparuj z innym telefonem / odtwórz telefon"),
    h(
      "p",
      { class: "hint" },
      "Nowy albo przeinstalowany telefon: wybierz w nim „Dodaj wtyczkę” (telefon z sejfem) albo „Odtwórz z wtyczki” (pusty telefon) i przepisz adres i kod. Hasła z tej przeglądarki zostają.",
    ),
    form(
      repair,
      ...other.fields,
      ...code.nodes,
      h("label", {}, MASTER_PASSWORD_LABEL),
      passwordField(password).row,
      h("div", { class: "actions" }, h("button", { type: "submit" }, "Sparuj")),
    ),
    status,
  );
}
