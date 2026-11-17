// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { LOCKED } from "../../src/autofill/fill-tab.ts";
import { startPromptPage } from "../../src/save/prompt-page.ts";
import type {
  SaveAnswerMessage,
  SaveInfoMessage,
  SavePreviewMessage,
  SavePromptInfo,
  SaveUnlockMessage,
} from "../../src/save/messages.ts";

const info = (over: Partial<SavePromptInfo> = {}): SavePromptInfo =>
  ({
    id: "c1",
    host: "shop.pl",
    username: "jan",
    password: "s3cret",
    decision: "create",
    locked: false,
    ...over,
  }) as SavePromptInfo;
const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (el: Element, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === text);

function runtime(infos: Array<SavePromptInfo | undefined>, answers: unknown[] = []) {
  const sent: Array<SaveInfoMessage | SaveAnswerMessage | SavePreviewMessage | SaveUnlockMessage> =
    [];
  const close = vi.fn(() => undefined);
  return {
    sent,
    close,
    send: async (
      m: SaveInfoMessage | SaveAnswerMessage | SavePreviewMessage | SaveUnlockMessage,
    ) => {
      sent.push(m);
      return m.type === "save-info" ? infos.shift() : answers.shift();
    },
  };
}

describe("startPromptPage", () => {
  it("shows the question for the candidate", async () => {
    const app = document.createElement("div");
    const rt = runtime([info()]);
    await startPromptPage(app, "c1", rt);
    expect(rt.sent).toEqual([{ target: "background", type: "save-info", candidateId: "c1" }]);
    expect(app.textContent).toContain("Nowy login");
  });

  it("drops the candidate and closes the window when there is nothing to ask about", async () => {
    const app = document.createElement("div");
    const rt = runtime([undefined], [{ ok: true }]);
    await startPromptPage(app, "c1", rt);
    expect(rt.sent).toEqual([
      { target: "background", type: "save-info", candidateId: "c1" },
      { target: "background", type: "save-answer", candidateId: "c1", answer: "later" },
    ]);
    expect(app.childElementCount).toBe(0);
    expect(rt.close).toHaveBeenCalledOnce();
  });

  it("closes without an id", async () => {
    const rt = runtime([info()]);
    await startPromptPage(document.createElement("div"), null, rt);
    expect(rt.sent).toEqual([]);
    expect(rt.close).toHaveBeenCalledOnce();
  });

  it("a vault locked after the window loaded turns Zapisz into Odblokuj i zapisz", async () => {
    const app = document.createElement("div");
    const rt = runtime(
      [info(), info({ decision: null, locked: true })],
      [{ ok: false, error: LOCKED }],
    );
    await startPromptPage(app, "c1", rt);
    button(app, "Zapisz")!.click();
    await flush();
    await flush();
    expect(rt.sent.map((m) => m.type)).toEqual(["save-info", "save-answer", "save-info"]);
    button(app, "Odblokuj i zapisz")!.click();
    expect(rt.sent.at(-1)).toEqual({
      target: "background",
      type: "save-unlock",
      candidateId: "c1",
    });
    expect(rt.close).not.toHaveBeenCalled();
  });

  it("a failed save whose candidate is gone closes the window", async () => {
    const app = document.createElement("div");
    const rt = runtime(
      [info(), undefined],
      [{ ok: false, error: "Pytanie o zapis wygasło" }, { ok: true }],
    );
    await startPromptPage(app, "c1", rt);
    button(app, "Zapisz")!.click();
    await flush();
    await flush();
    await flush();
    expect(rt.sent.map((m) => (m.type === "save-answer" ? m.answer : m.type))).toEqual([
      "save-info",
      "save",
      "save-info",
      "later",
    ]);
    expect(rt.close).toHaveBeenCalledOnce();
  });

  it("forwards previews and drafts to the background", async () => {
    const app = document.createElement("div");
    const rt = runtime([info()], [{ decision: "create" }, { ok: true }]);
    await startPromptPage(app, "c1", rt);
    const login = app.querySelector<HTMLInputElement>('input[aria-label="Login"]')!;
    login.value = "ala";
    login.dispatchEvent(new Event("input"));
    await flush();
    button(app, "Zapisz")!.click();
    await flush();
    expect(rt.sent.slice(1)).toEqual([
      {
        target: "background",
        type: "save-preview",
        candidateId: "c1",
        username: "ala",
        password: "s3cret",
      },
      {
        target: "background",
        type: "save-answer",
        candidateId: "c1",
        answer: "save",
        draft: { name: "shop.pl", username: "ala", password: "s3cret" },
      },
    ]);
  });
});
