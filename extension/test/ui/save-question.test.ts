// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { SavePromptInfo } from "../../src/save/messages.ts";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(teardownPopup);

const INFO: SavePromptInfo = { id: "c1", host: "sklep.example.com", username: "jan", password: "", decision: "create", locked: false };
const TAB = { id: 7, url: "https://sklep.example.com/login" };

describe("pytanie o zapis po odblokowaniu", () => {
  it("shows the question instead of the list", async () => {
    const { app, messages } = await setupPopup([], { activeTab: TAB, saveInfo: INFO });
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.textContent?.includes("Zapisać login w PassHolder?"));
    expect(messages).toContainEqual({ target: "background", type: "save-info", tabId: 7 });
    expect(app.textContent).toContain("sklep.example.com");
  });

  it("Zapisz leads to the list with „Zapisano login.”", async () => {
    const { app, messages } = await setupPopup([], { activeTab: TAB, saveInfo: INFO });
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.textContent?.includes("Zapisać login"));
    await click(byText(app, "Zapisz"));
    await settle(() => app.textContent?.includes("Zapisano login."));
    expect(messages).toContainEqual({ target: "background", type: "save-answer", candidateId: "c1", answer: "save" });
    expect(app.querySelector(".tabs")).toBeTruthy();
  });

  it("Nie teraz leads to the plain list", async () => {
    const { app } = await setupPopup([], { activeTab: TAB, saveInfo: INFO });
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.textContent?.includes("Zapisać login"));
    await click(byText(app, "Nie teraz"));
    await settle(() => app.querySelector(".tabs"));
    expect(app.textContent).not.toContain("Zapisano");
  });

  it("without info the list shows as before", async () => {
    const { app } = await setupPopup([], { activeTab: TAB });
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.querySelector(".tabs"));
    expect(app.textContent).not.toContain("Zapisać login");
  });

  it("without an active tab it does not ask the service worker", async () => {
    const { app, messages } = await setupPopup([], { saveInfo: INFO });
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.querySelector(".tabs"));
    expect(messages.some((m) => (m as { type: string }).type === "save-info")).toBe(false);
  });

  it("falls back to the list when sendMessage rejects", async () => {
    const { app } = await setupPopup([], { activeTab: TAB, saveInfo: new Error("no worker") });
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.querySelector(".tabs"));
  });
});
