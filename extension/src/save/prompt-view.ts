/** The save question shared by the panel page (save-prompt.html) and the popup. It never sees the password. */
import { h, statusLine } from "../ui/dom.ts";
import { setStatus } from "../ui/status.ts";
import type { SavePromptInfo } from "./messages.ts";

export type PromptAnswer = "save" | "later" | "never";

export interface PromptActions {
  answer(answer: PromptAnswer): Promise<{ ok: boolean; error?: string }>;
  unlock(): void;
  /** Called after a successful save, with the text shown to the user. */
  done(message: string): void;
}

export function promptView(info: SavePromptInfo, actions: PromptActions): HTMLElement {
  const status = statusLine();
  const title = info.decision === "update" ? "Zaktualizować hasło w PassHolder?" : "Zapisać login w PassHolder?";
  const buttons: HTMLButtonElement[] = [];

  const send = async (answer: PromptAnswer) => {
    buttons.forEach((b) => (b.disabled = true));
    setStatus(status, "");
    try {
      const result = await actions.answer(answer);
      if (!result.ok) throw new Error(result.error ?? "Nie udało się zapisać.");
      if (answer === "save") {
        setStatus(status, "Zapisano");
        actions.done("Zapisano");
      }
    } catch (error) {
      setStatus(status, (error as Error).message, true);
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  const button = (label: string, props: Partial<Record<string, unknown>>, onclick: () => void) => {
    const b = h("button", { type: "button", ...props, onclick }, label);
    buttons.push(b);
    return b;
  };

  const primary = info.locked
    ? button("Odblokuj i zapisz", { class: "primary" }, () => actions.unlock())
    : button(info.decision === "update" ? "Aktualizuj" : "Zapisz", { class: "primary" }, () => void send("save"));

  return h(
    "section",
    { class: "save-prompt" },
    h(
      "div",
      { class: "save-head" },
      h("h1", {}, title),
      button("×", { class: "small close", "aria-label": "Zamknij", title: "Zamknij" }, () => void send("later")),
    ),
    h("div", { class: "name" }, info.host),
    h("div", { class: "user" }, info.username || "(bez loginu)"),
    h(
      "div",
      { class: "actions" },
      primary,
      button("Nie teraz", {}, () => void send("later")),
      button("Nigdy dla tej strony", { class: "small" }, () => void send("never")),
    ),
    status,
  );
}
