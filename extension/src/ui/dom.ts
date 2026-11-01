/** Small DOM helpers shared by all views of popup.html. */

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

export function setStatus(el: HTMLElement, text: string, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
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

export function pinInput(autocomplete = "off") {
  return h("input", { type: "password", inputmode: "numeric", pattern: "[0-9]{4,6}", maxlength: 6, autocomplete, class: "mono" });
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
export function confirmButton(label: string, props: Partial<Record<string, unknown>>, action: () => void) {
  let confirmed = false;
  const button = h("button", {
    ...props,
    onclick: () => {
      if (!confirmed) {
        confirmed = true;
        button.textContent = "Na pewno? Kliknij ponownie";
        return;
      }
      action();
    },
  }, label);
  return button;
}
