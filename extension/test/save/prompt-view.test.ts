// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptView } from "../../src/save/prompt-view.ts";
import type { SavePreviewResponse, SavePromptInfo } from "../../src/save/messages.ts";

const info = (over: Partial<SavePromptInfo> = {}): SavePromptInfo => ({
  id: "c1",
  host: "sklep.example.com",
  username: "jan",
  password: "s3cret",
  decision: "create",
  locked: false,
  ...over,
});

type Preview = (u: string, p: string) => Promise<SavePreviewResponse>;
function setup(
  over: Partial<SavePromptInfo> = {},
  answer = vi.fn(
    async (_a: string, _d?: unknown) => ({ ok: true }) as { ok: boolean; error?: string },
  ),
  preview = vi.fn<Preview>(async () => ({ decision: "create" })),
) {
  const actions = { answer, preview, unlock: vi.fn(), done: vi.fn() };
  const el = promptView(info(over), actions);
  document.body.replaceChildren(el);
  return { el, ...actions };
}
const button = (el: Element, text: string) =>
  [...el.querySelectorAll("button")].find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text,
  )!;
const input = (el: Element, label: string) =>
  el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const type = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input"));
};
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => document.body.replaceChildren());

describe("promptView", () => {
  it("shows editable fields for a new login", () => {
    const { el } = setup();
    expect(el.querySelector("h1")?.textContent).toBe("Nowy login");
    expect(input(el, "Nazwa").value).toBe("sklep.example.com");
    expect(input(el, "Login").value).toBe("jan");
    expect(input(el, "Hasło").value).toBe("s3cret");
    expect(input(el, "Hasło").type).toBe("password");
    expect(el.textContent).toContain("Strona: sklep.example.com");
    expect(button(el, "Zapisz")).toBeTruthy();
    expect(button(el, "Nie teraz")).toBeTruthy();
    expect(button(el, "Nigdy dla tej strony")).toBeTruthy();
  });

  it("the password field has Pokaż but no Kopiuj", () => {
    const { el } = setup();
    expect(button(el, "Pokaż")).toBeTruthy();
    expect(button(el, "Kopiuj")).toBeUndefined();
  });

  it("Zapisz stays off while saving and after Zapisano, even when typing", async () => {
    let resolve!: (v: { ok: boolean }) => void;
    const answer = vi.fn(() => new Promise<{ ok: boolean }>((r) => (resolve = r)));
    const { el } = setup({}, answer as never);
    const save = button(el, "Zapisz") as HTMLButtonElement;
    save.click();
    await flush();
    expect(save.disabled).toBe(true);
    type(input(el, "Hasło"), "inne");
    await flush();
    expect(save.disabled).toBe(true);
    resolve({ ok: true });
    await flush();
    type(input(el, "Hasło"), "jeszcze");
    await flush();
    expect(el.textContent).toContain("Zapisano");
    expect(save.disabled).toBe(true);
  });

  it("an update hides the name and names the entry", () => {
    const { el } = setup({ decision: "update", entryName: "Sklep" });
    expect(el.querySelector("h1")?.textContent).toBe("Zmiana hasła: Sklep");
    expect(input(el, "Nazwa").closest("div")!.hidden).toBe(true);
    const hint = [...el.querySelectorAll<HTMLElement>(".hint")].find((d) =>
      d.textContent?.includes("Poprzednie hasło"),
    );
    expect(hint?.hidden).toBe(false);
  });

  it("a new login does not show the replace hint", () => {
    const { el } = setup({ decision: "create" });
    const hint = [...el.querySelectorAll<HTMLElement>(".hint")].find((d) =>
      d.textContent?.includes("Poprzednie hasło"),
    );
    expect(hint?.hidden).toBe(true);
  });

  it("typing asks for a preview and updates the header", async () => {
    const preview = vi.fn<Preview>(async () => ({ decision: "none" }));
    const { el } = setup({}, undefined, preview);
    type(input(el, "Login"), "nowy");
    await flush();
    expect(preview).toHaveBeenCalledWith("nowy", "s3cret");
    expect(el.querySelector("h1")?.textContent).toBe("Ten login jest już zapisany");
    expect((button(el, "Zapisz") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a preview that turns into an update shows the entry and hides the name", async () => {
    const preview = vi.fn<Preview>(async () => ({ decision: "update", entryName: "Sklep" }));
    const { el } = setup({}, undefined, preview);
    type(input(el, "Hasło"), "inne");
    await flush();
    expect(el.querySelector("h1")?.textContent).toBe("Zmiana hasła: Sklep");
    expect(input(el, "Nazwa").closest("div")!.hidden).toBe(true);
  });

  it("an empty password disables Zapisz", async () => {
    const { el } = setup();
    type(input(el, "Hasło"), "");
    expect((button(el, "Zapisz") as HTMLButtonElement).disabled).toBe(true);
    await flush();
    expect((button(el, "Zapisz") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an undefined preview keeps the header", async () => {
    const { el } = setup(
      {},
      undefined,
      vi.fn<Preview>(async () => undefined),
    );
    type(input(el, "Login"), "x");
    await flush();
    expect(el.querySelector("h1")?.textContent).toBe("Nowy login");
  });

  it("only the latest preview counts", async () => {
    const resolvers: Array<(r: SavePreviewResponse) => void> = [];
    const preview = vi.fn<Preview>(() => new Promise((r) => resolvers.push(r)));
    const { el } = setup({}, undefined, preview);
    type(input(el, "Login"), "a");
    type(input(el, "Login"), "ab");
    resolvers[1]!({ decision: "create" });
    await flush();
    resolvers[0]!({ decision: "none" });
    await flush();
    expect(el.querySelector("h1")?.textContent).toBe("Nowy login");
    expect((button(el, "Zapisz") as HTMLButtonElement).disabled).toBe(false);
  });

  it("locked shows no fields and no password", () => {
    const { el } = setup({ decision: null, locked: true, password: "" });
    expect(el.querySelector("input")).toBeNull();
    expect(el.textContent).not.toContain("s3cret");
    expect(button(el, "Odblokuj i zapisz")).toBeTruthy();
  });

  it("locked: title of saving and „Odblokuj i zapisz”", () => {
    const { el, unlock, answer } = setup({ decision: null, locked: true });
    expect(el.textContent).toContain("Zapisać login w PassHolder?");
    button(el, "Odblokuj i zapisz").click();
    expect(unlock).toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it("an empty login reads „(bez loginu)”", () => {
    expect(
      setup({ username: "", decision: null, locked: true, password: "" }).el.textContent,
    ).toContain("(bez loginu)");
  });

  it("Zapisz sends the edited draft", async () => {
    const { el, answer, done } = setup();
    type(input(el, "Nazwa"), "Mój");
    type(input(el, "Hasło"), "inne");
    await flush();
    button(el, "Zapisz").click();
    await flush();
    expect(answer).toHaveBeenCalledWith("save", { name: "Mój", username: "jan", password: "inne" });
    expect(el.textContent).toContain("Zapisano");
    expect(done).toHaveBeenCalledWith("Zapisano");
  });

  it("Nigdy dla tej strony answers never", async () => {
    const { el, answer } = setup();
    button(el, "Nigdy dla tej strony").click();
    await flush();
    expect(answer).toHaveBeenCalledWith("never", undefined);
  });

  it("the cross and Nie teraz answer later", async () => {
    const a = setup();
    button(a.el, "Zamknij").click();
    await flush();
    expect(a.answer).toHaveBeenCalledWith("later", undefined);
    const b = setup();
    button(b.el, "Nie teraz").click();
    await flush();
    expect(b.answer).toHaveBeenCalledWith("later", undefined);
  });

  it("shows the error and keeps the buttons", async () => {
    const { el, done } = setup(
      {},
      vi.fn(async () => ({ ok: false, error: "Sejf jest zablokowany" })),
    );
    button(el, "Zapisz").click();
    await flush();
    expect(el.querySelector(".status.error")?.textContent).toBe("Sejf jest zablokowany");
    expect(done).not.toHaveBeenCalled();
    expect((button(el, "Zapisz") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a rejected answer shows an error too", async () => {
    const { el } = setup(
      {},
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    button(el, "Zapisz").click();
    await flush();
    expect(el.querySelector(".status.error")?.textContent).toBe("boom");
  });
});
