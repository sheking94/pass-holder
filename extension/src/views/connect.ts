import { busy, form, h, passwordField, setStatus, show, statusLine } from "../ui/dom.ts";
import { IN_TAB, showInTab } from "../ui/page.ts";
import { requestHostPermission, serverUrlFields } from "../ui/server-url-fields.ts";
import { store } from "../ui/state.ts";
import { listView } from "./list.ts";

const MIN_MASTER_PASSWORD = 12;

/**
 * Shows the connect form here if this is a tab, otherwise moves it to the ?setup tab.
 * Chrome closes the popup as soon as it shows the host permission prompt, so the code after
 * chrome.permissions.request never ran there and the vault was never created.
 */
export function showConnect() {
  if (IN_TAB) return connectView();
  show(
    h("h1", {}, "PassHolder: połącz z serwerem"),
    h("p", {}, "Połączenie z serwerem ustawia się w osobnej karcie, bo Chrome zamyka to okienko, gdy pyta o zgodę na dostęp do serwera."),
    h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => void showInTab("setup", connectView) }, "Otwórz ustawienia połączenia")),
  );
}

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
    requestHostPermission(typed.origins, status, () => {
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
