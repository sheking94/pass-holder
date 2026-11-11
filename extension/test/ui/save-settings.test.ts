// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "../../src/storage.ts";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(teardownPopup);

const toggle = (app: Element) => app.querySelector<HTMLInputElement>("input[type=checkbox]")!;

async function open(options: Parameters<typeof setupPopup>[1] = {}, never: string[] = []) {
  const ctx = await setupPopup([], options);
  if (never.length > 0) await chrome.storage.local.set({ [STORAGE_KEYS.saveNever]: never });
  const { listView } = await import("../../src/views/list.ts");
  listView();
  await click(byText(ctx.app, "Zapis"));
  await settle(() => ctx.app.querySelector("h1")?.textContent === "Zapis haseł");
  return ctx;
}

describe("Zapis haseł", () => {
  it("shows the toggle off when the permission is missing", async () => {
    const { app } = await open({ permissions: { held: [] } });
    expect(byText(app, "Pytaj o zapis haseł")).toBeTruthy();
    expect(toggle(app).checked).toBe(false);
    expect(app.textContent).toContain("Brak");
  });

  it("turns on when Chrome grants the permission", async () => {
    const { app, permissions } = await open({ permissions: { held: [], requestResult: true } });
    toggle(app).click();
    await settle(() => toggle(app).checked);
    expect(permissions.requests).toEqual([["https://*/*", "http://*/*"]]);
  });

  it("stays off when the user refuses", async () => {
    const { app, permissions } = await open({ permissions: { held: [], requestResult: false } });
    toggle(app).click();
    await settle(() => permissions.requests.length === 1);
    await click(app);
    expect(toggle(app).checked).toBe(false);
  });

  it("turning off removes the permission (http kept for an http phone)", async () => {
    const { app, permissions } = await open({ permissions: { held: ["https://*/*"] } });
    expect(toggle(app).checked).toBe(true);
    toggle(app).click();
    await settle(() => !toggle(app).checked);
    expect(permissions.removed).toEqual([["https://*/*"]]);
  });

  it("Usuń takes a host off the never list", async () => {
    const { app } = await open({}, ["a.example", "b.example"]);
    expect(app.textContent).toContain("a.example");
    await click(byText(app, "Usuń", 0));
    await settle(() => !app.textContent!.includes("a.example"));
    expect(app.textContent).toContain("b.example");
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.saveNever))[STORAGE_KEYS.saveNever];
    expect(stored).toEqual(["b.example"]);
  });
});
