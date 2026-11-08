/** Small DOM helpers shared by all views of popup.html. */
import { LONG_PIN_MAX_LENGTH } from "../pin-lock.ts";
import { copySecret, copyText } from "./copy.ts";
import { setStatus } from "./status.ts";

export { setStatus };

const app = document.getElementById("app")!;

export type Child = Node | string | false | undefined;

/** Small DOM helper: h("button", { class: "primary", onclick }, "Zapisz"). */
export function h<K extends keyof HTMLElementTagNameMap>(
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

/** Replaces the whole page with a new view. */
export function show(...children: Child[]) {
  app.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)));
}

export function statusLine() {
  return h("div", { class: "status", role: "status" });
}

/** Runs an async action with the buttons disabled and errors shown in the status line. */
export async function busy(status: HTMLElement, message: string, action: () => Promise<void>) {
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

/** A password input with a button that shows or hides what was typed. */
export function passwordField(input: HTMLInputElement) {
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
 * A field with „Kopiuj” and, while secret, hidden behind „Pokaż/Ukryj”; copying a secret clears the
 * clipboard after a minute. setSecret(false) makes it a plain field (e.g. a custom field not marked hidden).
 */
export function secretField(input: HTMLInputElement, what: string, status: HTMLElement) {
  let secret = true;
  const toggle = h("button", { type: "button", title: `Pokaż lub ukryj: ${what}` });
  const copy = h("button", {
    type: "button",
    title: `Kopiuj: ${what}`,
    onclick: () => {
      if (input.value === "") return setStatus(status, "Pole jest puste");
      void (secret ? copySecret : copyText)(input.value, what, status).catch((error: Error) => setStatus(status, error.message, true));
    },
  }, "Kopiuj");
  const setVisible = (visible: boolean) => {
    input.type = visible || !secret ? "text" : "password";
    toggle.textContent = visible ? "Ukryj" : "Pokaż";
    toggle.setAttribute("aria-pressed", String(visible));
  };
  const setSecret = (value: boolean) => {
    secret = value;
    toggle.hidden = !value;
    setVisible(false);
  };
  toggle.addEventListener("click", () => setVisible(input.type === "password"));
  setSecret(true);
  return { row: h("div", { class: "row" }, h("div", { class: "grow" }, input), toggle, copy), setVisible, setSecret };
}

/** A PIN input: 4-6 digits, or with long=true a long PIN (letters too, see pin-lock.ts). */
export function pinInput(autocomplete = "off", long = false) {
  const input = h("input", { type: "password", autocomplete, class: "mono" });
  setPinShape(input, long);
  return input;
}

/** Switches a PIN input between a short numeric PIN and a long one. */
export function setPinShape(input: HTMLInputElement, long: boolean) {
  input.inputMode = long ? "text" : "numeric";
  input.maxLength = long ? LONG_PIN_MAX_LENGTH : 6;
  if (long) input.removeAttribute("pattern");
  else input.pattern = "[0-9]{4,6}";
}

/**
 * A form whose submit button (and Enter in any of its inputs) runs onSubmit.
 * Other buttons inside must have type "button", or Enter would click them too.
 */
export function form(onSubmit: () => void, ...children: Child[]) {
  return h("form", {
    onsubmit: (event: Event) => {
      event.preventDefault();
      onSubmit();
    },
  }, ...children);
}

/** A button that asks "Na pewno?" on the first click and runs action on the second. */
export function confirmButton(
  label: string,
  props: Partial<Record<string, unknown>>,
  action: () => void,
  confirmLabel = "Na pewno? Kliknij ponownie",
) {
  let confirmed = false;
  const button = h("button", {
    ...props,
    onclick: () => {
      if (!confirmed) {
        confirmed = true;
        button.textContent = confirmLabel;
        return;
      }
      action();
    },
  }, label);
  return button;
}
