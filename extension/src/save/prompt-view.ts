import type { ActionResult } from "../result.ts";
/**
 * The save question shared by the panel page (save-prompt.html) and the popup. With the vault open it shows
 * editable fields; locked, it shows no password (the info carries none).
 */
import { errorMessage } from "../error-messages.ts";
import { h, secretField, statusLine } from "../ui/dom.ts";
import { setStatus } from "../ui/status.ts";
import type { SaveDraft, SavePreviewResponse, SavePromptInfo } from "./messages.ts";

export type PromptAnswer = "save" | "later" | "never";

export interface PromptActions {
  answer(answer: PromptAnswer, draft?: SaveDraft): Promise<ActionResult>;
  preview(username: string, password: string): Promise<SavePreviewResponse>;
  unlock(): void;
  /** Called after a successful save, with the text shown to the user. */
  done(message: string): void;
}

type Decision = NonNullable<SavePreviewResponse>["decision"];

/** The editable fields of the open-vault question. */
function promptFields(info: SavePromptInfo, status: HTMLElement) {
  const field = (label: string, props: Partial<Record<string, unknown>>) =>
    h("input", { type: "text", autocomplete: "off", "aria-label": label, ...props });
  const name = field("Nazwa", { value: info.host });
  const username = field("Login", { value: info.username });
  const password = field("Hasło", { type: "password", class: "mono", value: info.password });
  return {
    name,
    username,
    password,
    passwordRow: secretField(password, "hasło", status, { copy: false }).row,
    nameBox: h("div", {}, h("label", {}, "Nazwa"), name),
    // „Zapisz” replaces the entry's password: say so, and where the old one goes (review V3-S1).
    replaceHint: h(
      "div",
      { class: "hint" },
      "Obecne hasło trafi do pola „Poprzednie hasło” we wpisie.",
    ),
  };
}

/** The question's state: the decision shown in the header, the buttons, and sending the answer. */
class SavePrompt {
  readonly status = statusLine();
  readonly title = h("h1", {}, "Zapisać login w PassHolder?");
  readonly fields: ReturnType<typeof promptFields>;
  readonly primary: HTMLButtonElement;
  readonly actionRow: HTMLElement;
  readonly close: HTMLButtonElement;
  private readonly buttons: HTMLButtonElement[] = [];
  // Only the answer to the latest preview counts: a slow earlier one must not overwrite a newer header.
  private decision: Decision;
  private latest = 0;
  private saving = false; // in flight or done: Zapisz stays off until a failure

  constructor(
    private readonly info: SavePromptInfo,
    private readonly actions: PromptActions,
  ) {
    this.decision = info.decision ?? "create";
    this.fields = promptFields(info, this.status);
    this.primary = info.locked
      ? this.button("Odblokuj i zapisz", { class: "primary" }, () => actions.unlock())
      : this.button("Zapisz", { class: "primary" }, () => void this.send("save"));
    this.actionRow = h(
      "div",
      { class: "actions" },
      this.primary,
      this.button("Nie teraz", {}, () => void this.send("later")),
      this.button("Nigdy dla tej strony", { class: "small" }, () => void this.send("never")),
    );
    this.close = this.button(
      "×",
      { class: "small close", "aria-label": "Zamknij", title: "Zamknij" },
      () => void this.send("later"),
    );
    this.fields.username.addEventListener("input", () => void this.preview());
    this.fields.password.addEventListener("input", () => void this.preview());
  }

  private button(label: string, props: Partial<Record<string, unknown>>, onclick: () => void) {
    const b = h("button", { type: "button", ...props, onclick }, label);
    this.buttons.push(b);
    return b;
  }

  refresh(entryName?: string): void {
    const { info, decision } = this;
    this.title.textContent =
      decision === "none"
        ? "Ten login jest już zapisany"
        : decision === "update"
          ? `Zmiana hasła: ${entryName ?? (info.locked ? undefined : info.entryName) ?? ""}`
          : "Nowy login";
    this.fields.nameBox.hidden = decision !== "create";
    this.fields.replaceHint.hidden = decision !== "update";
    this.primary.disabled = this.saving || decision === "none" || this.fields.password.value === "";
  }

  private async preview(): Promise<void> {
    const call = ++this.latest;
    this.refresh(); // an empty password disables Zapisz at once, before the answer
    try {
      const { username, password } = this.fields;
      const result = await this.actions.preview(username.value, password.value);
      if (call !== this.latest || !result) return;
      this.decision = result.decision;
      this.refresh(result.entryName);
    } catch {
      // keep the current header; saving reports any real problem
    }
  }

  private async send(answer: PromptAnswer): Promise<void> {
    if (answer === "save") this.saving = true;
    this.buttons.forEach((b) => (b.disabled = true));
    setStatus(this.status, "");
    try {
      const result = await this.actions.answer(answer, this.draft(answer));
      if (!result.ok) throw new Error(result.error);
      if (answer === "save") {
        setStatus(this.status, "Zapisano");
        this.actions.done("Zapisano");
      }
    } catch (error) {
      this.saving = false;
      setStatus(this.status, errorMessage(error), true);
      this.buttons.forEach((b) => (b.disabled = false));
      if (!this.info.locked) this.refresh();
    }
  }

  /** The edited data for „Zapisz” with the vault open; none otherwise. */
  private draft(answer: PromptAnswer): SaveDraft | undefined {
    if (answer !== "save" || this.info.locked) return undefined;
    const { name, username, password } = this.fields;
    return { name: name.value, username: username.value, password: password.value };
  }
}

/** Locked: the site and the login only, and „Odblokuj i zapisz”. */
function lockedLayout(prompt: SavePrompt, info: SavePromptInfo): HTMLElement {
  return h(
    "section",
    { class: "save-prompt" },
    h("div", { class: "save-head" }, prompt.title, prompt.close),
    h("div", { class: "name" }, info.host),
    h("div", { class: "user" }, info.username || "(bez loginu)"),
    prompt.actionRow,
    prompt.status,
  );
}

/** Open vault: the editable name, login and password. */
function unlockedLayout(prompt: SavePrompt, info: SavePromptInfo): HTMLElement {
  prompt.refresh();
  const f = prompt.fields;
  return h(
    "section",
    { class: "save-prompt" },
    h("div", { class: "save-head" }, prompt.title, prompt.close),
    f.nameBox,
    h("label", {}, "Login"),
    f.username,
    h("label", {}, "Hasło"),
    f.passwordRow,
    f.replaceHint,
    h("div", { class: "site" }, `Strona: ${info.host}`),
    prompt.actionRow,
    prompt.status,
  );
}

export function promptView(info: SavePromptInfo, actions: PromptActions): HTMLElement {
  const prompt = new SavePrompt(info, actions);
  return info.locked ? lockedLayout(prompt, info) : unlockedLayout(prompt, info);
}
