import {
  invalidPinMessage,
  isValidPin,
  LONG_PIN_MIN_LENGTH,
  MAX_PIN_ATTEMPTS,
} from "../pin-lock.ts";
import type { PinStatus } from "../pin-store.ts";
import {
  busy,
  form,
  h,
  passwordField,
  pinInput,
  setPinShape,
  setStatus,
  show,
  statusLine,
} from "../ui/dom.ts";
import { store } from "../ui/state.ts";
import { backToListButton, views } from "./router.ts";

/** "PIN" on the list: how the PIN is set up now, or the form that turns it on. */
export async function pinSettingsView() {
  const current = await store.pinStatus();
  if (current) pinEnabledView(current);
  else pinSetupView();
}

function pinEnabledView(current: PinStatus) {
  show(
    h("h1", {}, "Logowanie PIN-em"),
    h(
      "p",
      {},
      "PIN jest włączony. ",
      current.rememberedAfterRestart
        ? "Działa też po ponownym uruchomieniu przeglądarki."
        : "Po zamknięciu przeglądarki trzeba będzie raz podać hasło główne.",
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          class: "danger",
          onclick: async () => {
            await store.disablePin();
            views().list({
              message: "PIN wyłączony. Do odblokowania potrzebne będzie hasło główne.",
            });
          },
        },
        "Wyłącz PIN",
      ),
      backToListButton(),
    ),
    statusLine(),
  );
}

function pinSetupView() {
  const pin = pinInput({ autocomplete: "new-password" });
  const repeat = pinInput({ autocomplete: "new-password" });
  const label = h("label", {});
  const status = statusLine();
  // On disk the PIN must be long (S4 of the security review), so the inputs change with the checkbox.
  const setLong = (long: boolean) => {
    label.textContent = long
      ? `PIN (co najmniej ${LONG_PIN_MIN_LENGTH} znaków, nie same cyfry)`
      : "PIN (4-6 cyfr)";
    setPinShape(pin, long);
    setPinShape(repeat, long);
  };
  const remember = h("input", { type: "checkbox", onchange: () => setLong(remember.checked) });
  setLong(false);
  const submit = () => {
    if (!isValidPin(pin.value, remember.checked))
      return setStatus(status, invalidPinMessage(remember.checked), true);
    if (pin.value !== repeat.value) return setStatus(status, "PIN-y się różnią", true);
    void busy(status, "Liczę klucz z PIN-u…", async () => {
      await store.enablePin(pin.value, { rememberAfterRestart: remember.checked });
      views().list({ message: "PIN włączony. Użyjesz go po zablokowaniu sejfu." });
    });
  };

  show(
    h("h1", {}, "Włącz logowanie PIN-em"),
    h(
      "p",
      { class: "hint" },
      `PIN odblokowuje sejf tylko w tej przeglądarce. Hasło główne dalej działa. Po ${MAX_PIN_ATTEMPTS} błędnych PIN-ach z rzędu PIN zostanie wyłączony.`,
    ),
    form(
      submit,
      label,
      passwordField(pin).row,
      h("label", {}, "Powtórz PIN"),
      passwordField(repeat).row,
      h("label", { class: "check" }, remember, "Pamiętaj PIN po zamknięciu przeglądarki"),
      h(
        "p",
        { class: "hint" },
        `Bez tej opcji PIN jest tylko w pamięci przeglądarki. Z nią trafia na dysk, gdzie ktoś z kopią profilu Chrome mógłby zgadywać go bez limitu prób, dlatego musi mieć co najmniej ${LONG_PIN_MIN_LENGTH} znaków i nie same cyfry. Zalecane szyfrowanie dysku.`,
      ),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", class: "primary" }, "Włącz PIN"),
        backToListButton(),
      ),
    ),
    status,
  );
  pin.focus();
}
