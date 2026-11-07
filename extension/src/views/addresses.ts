import { busy, form, h, passwordField, setStatus, show, statusLine } from "../ui/dom.ts";
import { MODE, showInTab } from "../ui/page.ts";
import { requestHostPermission, serverUrlFields } from "../ui/server-url-fields.ts";
import { store } from "../ui/state.ts";
import { PairedButSyncFailed } from "../vault-store.ts";
import { showConnect } from "./connect.ts";
import { listView, skippedNote } from "./list.ts";

const REPAIRED: Record<"paired" | "restored", string> = {
  paired: "Sparowano z telefonem. Ta przeglądarka synchronizuje się teraz z nim.",
  restored: "Telefon odtworzony z tej wtyczki: ma już wszystkie hasła. Synchronizacja działa jak dotąd.",
};

/** Opens the address form in a tab: like pairing, it may need a host permission prompt. */
export function openAddresses() {
  return showInTab("addresses", addressesView);
}

/**
 * The phone's addresses of an already paired browser (no new pairing needed: the Noise handshake checks the
 * phone's key on every sync), and "Sparuj z innym telefonem / odtwórz telefon".
 */
export async function addressesView(message = "") {
  const account = await store.getAccount();
  if (!account) return showConnect();
  // The separate ?addresses tab has no list to go back to; it can just be closed.
  const ownTab = MODE === "addresses";
  const closeHint = ownTab ? " Możesz zamknąć tę kartę." : "";

  const addresses = serverUrlFields(account.phoneUrls);
  const status = statusLine();
  setStatus(status, message);
  const save = () => {
    const typed = addresses.read();
    if (typeof typed === "string") return setStatus(status, typed, true);
    requestHostPermission(typed.origins, status, () => {
      void busy(status, "Zapisuję…", async () => {
        await store.setPhoneUrls(typed.urls);
        setStatus(status, "Zapisano. Przy synchronizacji wtyczka sama wybierze adres, który odpowiada." + closeHint);
      });
    });
  };

  const other = serverUrlFields();
  const code = h("input", { type: "text", class: "mono", inputmode: "numeric", autocomplete: "off", maxLength: 9, placeholder: "12345678" });
  const password = h("input", { type: "password", autocomplete: "current-password" });
  const repairStatus = statusLine();
  const repair = () => {
    const typed = other.read();
    if (typeof typed === "string") return setStatus(repairStatus, typed, true);
    requestHostPermission(typed.origins, repairStatus, () => {
      void busy(repairStatus, "Paruję z telefonem…", async () => {
        let done: string;
        try {
          const { mode, skipped } = await store.repair(typed.urls, code.value, password.value);
          done = REPAIRED[mode] + skippedNote(skipped);
        } catch (error) {
          password.value = "";
          if (!(error instanceof PairedButSyncFailed)) throw error;
          done = error.message;
        }
        // The account now has the new phone's addresses: show them.
        await addressesView(done + closeHint);
      });
    });
  };

  show(
    h("h1", {}, "PassHolder: telefon"),
    h("p", {}, `Sparowano jako „${account.deviceName}” z telefonem „${account.phone.name}”.`),
    h("p", {}, "Adresy telefonu, np. w sieci domowej i w Tailscale. Telefon pokazuje je na ekranie Synchronizacja; te, które poda sam, wtyczka dopisuje przy synchronizacji."),
    form(
      save,
      ...addresses.fields,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", class: "primary" }, "Zapisz"),
        !ownTab && h("button", { type: "button", onclick: () => listView() }, "Wróć do listy"),
      ),
    ),
    status,
    h("fieldset", {},
      h("legend", {}, "Sparuj z innym telefonem / odtwórz telefon"),
      h("p", { class: "hint" }, "Nowy albo przeinstalowany telefon: wybierz w nim „Dodaj wtyczkę” (telefon z sejfem) albo „Odtwórz z wtyczki” (pusty telefon) i przepisz adres i kod. Hasła z tej przeglądarki zostają."),
      form(
        repair,
        ...other.fields,
        h("label", {}, "Kod parowania (8 cyfr)"),
        code,
        h("label", {}, "Hasło główne"),
        passwordField(password).row,
        h("div", { class: "actions" }, h("button", { type: "submit" }, "Sparuj")),
      ),
      repairStatus,
    ),
  );
  addresses.main.focus();
}
