// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { LOCKED } from "../../src/autofill/fill-tab.ts";
import { startPromptPage } from "../../src/save/prompt-page.ts";
import type { SaveAnswerMessage, SaveInfoMessage, SavePromptInfo } from "../../src/save/messages.ts";

const info = (over: Partial<SavePromptInfo> = {}): SavePromptInfo => ({
  id: "c1", host: "shop.pl", username: "jan", decision: "create", locked: false, ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (el: Element, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text);

function runtime(infos: Array<SavePromptInfo | undefined>, answers: unknown[] = []) {
  const sent: Array<SaveInfoMessage | SaveAnswerMessage> = [];
  const openPopup = vi.fn(async () => undefined);
  return {
    sent, openPopup,
    send: async (m: SaveInfoMessage | SaveAnswerMessage) => {
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
    expect(app.textContent).toContain("Zapisać login w PassHolder?");
  });

  it("asks to be taken away when there is nothing to ask about", async () => {
    const app = document.createElement("div");
    const rt = runtime([undefined], [{ ok: true }]);
    await startPromptPage(app, "c1", rt);
    expect(rt.sent).toEqual([
      { target: "background", type: "save-info", candidateId: "c1" },
      { target: "background", type: "save-answer", candidateId: "c1", answer: "later" },
    ]);
    expect(app.childElementCount).toBe(0);
  });

  it("does nothing without an id", async () => {
    const rt = runtime([info()]);
    await startPromptPage(document.createElement("div"), null, rt);
    expect(rt.sent).toEqual([]);
  });

  it("a vault locked after the panel loaded turns Zapisz into Odblokuj i zapisz", async () => {
    const app = document.createElement("div");
    const rt = runtime([info(), info({ decision: null, locked: true })], [{ ok: false, error: LOCKED }]);
    await startPromptPage(app, "c1", rt);
    button(app, "Zapisz")!.click();
    await flush(); await flush();
    expect(rt.sent.map((m) => m.type)).toEqual(["save-info", "save-answer", "save-info"]);
    button(app, "Odblokuj i zapisz")!.click();
    expect(rt.openPopup).toHaveBeenCalledOnce();
  });

  it("a failed save whose candidate is gone takes the panel away", async () => {
    const app = document.createElement("div");
    const rt = runtime([info(), undefined], [{ ok: false, error: "Pytanie o zapis wygasło" }, { ok: true }]);
    await startPromptPage(app, "c1", rt);
    button(app, "Zapisz")!.click();
    await flush(); await flush(); await flush();
    expect(rt.sent.map((m) => (m.type === "save-answer" ? m.answer : m.type))).toEqual(["save-info", "save", "save-info", "later"]);
  });
});
