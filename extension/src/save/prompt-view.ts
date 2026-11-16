/**
 * The save question shared by the panel page (save-prompt.html) and the popup. With the vault open it shows
 * editable fields; locked, it shows no password (the info carries none).
 */
import { h, secretField, statusLine } from "../ui/dom.ts";
import { setStatus } from "../ui/status.ts";
import type { SaveDraft, SavePreviewResponse, SavePromptInfo } from "./messages.ts";

export type PromptAnswer = "save" | "later" | "never";

export interface PromptActions {
  answer(answer: PromptAnswer, draft?: SaveDraft): Promise<{ ok: boolean; error?: string }>;
  preview(username: string, password: string): Promise<SavePreviewResponse>;
  unlock(): void;
  /** Called after a successful save, with the text shown to the user. */
  done(message: string): void;
}

export function promptView(info: SavePromptInfo, actions: PromptActions): HTMLElement {
  const status = statusLine();
  const buttons: HTMLButtonElement[] = [];

  const field = (label: string, props: Partial<Record<string, unknown>>) =>
    h("input", { type: "text", autocomplete: "off", "aria-label": label, ...props });
  const name = field("Nazwa", { value: info.host });
  const username = field("Login", { value: info.username });
  const password = field("Hasło", { type: "password", class: "mono", value: info.password });
  const passwordRow = secretField(password, "hasło", status, { copy: false });
  const title = h("h1", {}, "Zapisać login w PassHolder?");
  const nameBox = h("div", {}, h("label", {}, "Nazwa"), name);
  // „Zapisz” replaces the entry's password: say so, and where the old one goes (review V3-S1).
  const replaceHint = h(
    "div",
    { class: "hint" },
    "Obecne hasło trafi do pola „Poprzednie hasło” we wpisie.",
  );

  // Only the answer to the latest preview counts: a slow earlier one must not overwrite a newer header.
  let decision: NonNullable<SavePreviewResponse>["decision"] = info.decision ?? "create";
  let latest = 0;
  let saving = false; // in flight or done: Zapisz stays off until a failure
  const refresh = (entryName?: string) => {
    title.textContent =
      decision === "none"
        ? "Ten login jest już zapisany"
        : decision === "update"
          ? `Zmiana hasła: ${entryName ?? info.entryName ?? ""}`
          : "Nowy login";
    nameBox.hidden = decision !== "create";
    replaceHint.hidden = decision !== "update";
    primary.disabled = saving || decision === "none" || password.value === "";
  };
  const preview = async () => {
    const call = ++latest;
    refresh(); // an empty password disables Zapisz at once, before the answer
    try {
      const result = await actions.preview(username.value, password.value);
      if (call !== latest || !result) return;
      decision = result.decision;
      refresh(result.entryName);
    } catch {
      // keep the current header; saving reports any real problem
    }
  };
  username.addEventListener("input", () => void preview());
  password.addEventListener("input", () => void preview());

  const send = async (answer: PromptAnswer) => {
    if (answer === "save") saving = true;
    buttons.forEach((b) => (b.disabled = true));
    setStatus(status, "");
    try {
      const draft =
        answer === "save" && !info.locked
          ? { name: name.value, username: username.value, password: password.value }
          : undefined;
      const result = await actions.answer(answer, draft);
      if (!result.ok) throw new Error(result.error ?? "Nie udało się zapisać.");
      if (answer === "save") {
        setStatus(status, "Zapisano");
        actions.done("Zapisano");
      }
    } catch (error) {
      saving = false;
      setStatus(status, (error as Error).message, true);
      buttons.forEach((b) => (b.disabled = false));
      if (!info.locked) refresh();
    }
  };
  const button = (label: string, props: Partial<Record<string, unknown>>, onclick: () => void) => {
    const b = h("button", { type: "button", ...props, onclick }, label);
    buttons.push(b);
    return b;
  };

  const primary = info.locked
    ? button("Odblokuj i zapisz", { class: "primary" }, () => actions.unlock())
    : button("Zapisz", { class: "primary" }, () => void send("save"));
  const actionRow = h(
    "div",
    { class: "actions" },
    primary,
    button("Nie teraz", {}, () => void send("later")),
    button("Nigdy dla tej strony", { class: "small" }, () => void send("never")),
  );
  const close = button(
    "×",
    { class: "small close", "aria-label": "Zamknij", title: "Zamknij" },
    () => void send("later"),
  );

  if (info.locked) {
    return h(
      "section",
      { class: "save-prompt" },
      h("div", { class: "save-head" }, title, close),
      h("div", { class: "name" }, info.host),
      h("div", { class: "user" }, info.username || "(bez loginu)"),
      actionRow,
      status,
    );
  }
  refresh();
  return h(
    "section",
    { class: "save-prompt" },
    h("div", { class: "save-head" }, title, close),
    nameBox,
    h("label", {}, "Login"),
    username,
    h("label", {}, "Hasło"),
    passwordRow.row,
    replaceHint,
    h("div", { class: "site" }, `Strona: ${info.host}`),
    actionRow,
    status,
  );
}
