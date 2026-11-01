import { INVALID_PIN, isValidPin, MAX_PIN_ATTEMPTS } from "../pin-lock.ts";
import type { PinStatus } from "../pin-store.ts";
import { busy, form, h, passwordField, pinInput, setStatus, show, statusLine } from "../ui/dom.ts";
import { store } from "../ui/state.ts";
import { listView } from "./list.ts";

/** "PIN" on the list: how the PIN is set up now, or the form that turns it on. */
export async function pinSettingsView() {
  const current = await store.pinStatus();
  if (current) pinEnabledView(current);
  else pinSetupView();
}

function backButton() {
  return h("button", { type: "button", onclick: () => listView() }, "Wróć");
}

function pinEnabledView(current: PinStatus) {
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
      backButton(),
    ),
    statusLine(),
  );
}

function pinSetupView() {
  const pin = pinInput("new-password");
  const repeat = pinInput("new-password");
  const remember = h("input", { type: "checkbox" });
  const status = statusLine();
  const submit = () => {
    if (!isValidPin(pin.value)) return setStatus(status, INVALID_PIN, true);
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
      h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Włącz PIN"), backButton()),
    ),
    status,
  );
  pin.focus();
}
