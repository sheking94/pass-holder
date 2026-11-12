// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptView } from "../../src/save/prompt-view.ts";
import type { SavePromptInfo } from "../../src/save/messages.ts";

const info = (over: Partial<SavePromptInfo> = {}): SavePromptInfo => ({
  id: "c1", host: "sklep.example.com", username: "jan", password: "", decision: "create", locked: false, ...over,
});

function setup(over: Partial<SavePromptInfo> = {}, answer = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string })) {
  const actions = { answer, unlock: vi.fn(), done: vi.fn() };
  const el = promptView(info(over), actions);
  document.body.replaceChildren(el);
  return { el, ...actions };
}
const button = (el: Element, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text)!;
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => document.body.replaceChildren());

describe("promptView", () => {
  it("asks to save a new login", () => {
    const { el } = setup();
    expect(el.textContent).toContain("Zapisać login w PassHolder?");
    expect(el.textContent).toContain("sklep.example.com");
    expect(el.textContent).toContain("jan");
    expect(button(el, "Zapisz")).toBeTruthy();
    expect(button(el, "Nie teraz")).toBeTruthy();
    expect(button(el, "Nigdy dla tej strony")).toBeTruthy();
  });

  it("asks to update a password", () => {
    const { el } = setup({ decision: "update" });
    expect(el.textContent).toContain("Zaktualizować hasło w PassHolder?");
    expect(button(el, "Aktualizuj")).toBeTruthy();
  });

  it("locked: title of saving and „Odblokuj i zapisz”", () => {
    const { el, unlock, answer } = setup({ decision: null, locked: true });
    expect(el.textContent).toContain("Zapisać login w PassHolder?");
    button(el, "Odblokuj i zapisz").click();
    expect(unlock).toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it("an empty login reads „(bez loginu)”", () => {
    expect(setup({ username: "" }).el.textContent).toContain("(bez loginu)");
  });

  it("shows no password", () => {
    expect(setup().el.textContent).not.toContain("s3cret");
  });

  it("Zapisz answers save and shows Zapisano", async () => {
    const { el, answer, done } = setup();
    button(el, "Zapisz").click();
    await flush();
    expect(answer).toHaveBeenCalledWith("save");
    expect(el.textContent).toContain("Zapisano");
    expect(done).toHaveBeenCalledWith("Zapisano");
  });

  it("Nigdy dla tej strony answers never", async () => {
    const { el, answer } = setup();
    button(el, "Nigdy dla tej strony").click();
    await flush();
    expect(answer).toHaveBeenCalledWith("never");
  });

  it("the cross and Nie teraz answer later", async () => {
    const a = setup();
    button(a.el, "Zamknij").click();
    await flush();
    expect(a.answer).toHaveBeenCalledWith("later");
    const b = setup();
    button(b.el, "Nie teraz").click();
    await flush();
    expect(b.answer).toHaveBeenCalledWith("later");
  });

  it("shows the error and keeps the buttons", async () => {
    const { el, done } = setup({}, vi.fn(async () => ({ ok: false, error: "Sejf jest zablokowany" })));
    button(el, "Zapisz").click();
    await flush();
    expect(el.querySelector(".status.error")?.textContent).toBe("Sejf jest zablokowany");
    expect(done).not.toHaveBeenCalled();
    expect((button(el, "Zapisz") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a rejected answer shows an error too", async () => {
    const { el } = setup({}, vi.fn(async () => { throw new Error("boom"); }));
    button(el, "Zapisz").click();
    await flush();
    expect(el.querySelector(".status.error")?.textContent).toBe("boom");
  });
});
