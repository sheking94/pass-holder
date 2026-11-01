import { busy, form, h, setStatus, show, statusLine } from "../ui/dom.ts";
import { MODE, showInTab } from "../ui/page.ts";
import { requestHostPermission, serverUrlFields } from "../ui/server-url-fields.ts";
import { store } from "../ui/state.ts";
import { showConnect } from "./connect.ts";
import { listView } from "./list.ts";

/** Opens the address form in a tab: like connecting, it may need a host permission prompt. */
export function openAddresses() {
  return showInTab("addresses", addressesView);
}

/** Changes the server addresses of an already connected browser, without connecting again. */
export async function addressesView() {
  const account = await store.getAccount();
  if (!account) return showConnect();
  const addresses = serverUrlFields(account.serverUrls);
  const status = statusLine();
  // The separate ?addresses tab has no list to go back to; it can just be closed.
  const ownTab = MODE === "addresses";

  const submit = () => {
    const typed = addresses.read();
    if (typeof typed === "string") return setStatus(status, typed, true);
    requestHostPermission(typed.origins, status, () => {
      void busy(status, "Zapisuję…", async () => {
        await store.setServerUrls(typed.urls);
        setStatus(status, "Zapisano. Przy synchronizacji wtyczka sama wybierze adres, który odpowiada." + (ownTab ? " Możesz zamknąć tę kartę." : ""));
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
        !ownTab && h("button", { type: "button", onclick: () => listView() }, "Wróć do listy"),
      ),
    ),
    status,
  );
  addresses.main.focus();
}
