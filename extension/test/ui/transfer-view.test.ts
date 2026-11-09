// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(() => {
  teardownPopup();
  vi.restoreAllMocks();
});

const sample = readFileSync(resolve(__dirname, "../../../core/test-vectors/transfer/passholder.json"), "utf8");

async function open() {
  const ctx = await setupPopup();
  const { transferView } = await import("../../src/views/transfer.ts");
  transferView();
  const downloads: { name: string; type: string }[] = [];
  URL.createObjectURL = (blob: Blob | MediaSource) => `blob:${(blob as Blob).type}`;
  URL.revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, type: this.href.replace(/^blob:/, "") });
  });
  const status = () => ctx.app.querySelector(".status")!;
  return { ...ctx, downloads, status };
}

function chooseFile(app: Element, text: string) {
  const input = app.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([text], "x.json")] });
}

describe("transfer view", () => {
  it("shows the title, intro and three formats with PassHolder JSON selected", async () => {
    const { app } = await open();
    expect(app.querySelector("h1")!.textContent).toBe("Import i eksport");
    expect(app.textContent).toContain("Import rozpoznaje format sam: PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.");
    const radios = [...app.querySelectorAll<HTMLInputElement>("input[type=radio][name=format]")];
    expect(radios.map((r) => r.value)).toEqual(["passholder", "bitwarden", "nordpass"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(app.querySelector("input[type=file]")!.getAttribute("accept")).toBe(".json,.csv,application/json,text/csv");
  });

  it("refuses to export without the checkbox", async () => {
    const { app, downloads, status } = await open();
    await click(byText(app, "Pobierz plik"));
    expect(downloads).toEqual([]);
    expect(status().textContent).toBe("Najpierw zaznacz, że rozumiesz ryzyko.");
    expect(status().classList.contains("error")).toBe(true);
  });

  it.each([
    ["Bitwarden JSON", "bitwarden", "json", "application/json"],
    ["NordPass CSV", "nordpass", "csv", "text/csv;charset=utf-8"],
    ["PassHolder JSON (wszystko, bez strat)", "passholder", "json", "application/json"],
  ])("exports %s with the right file name", async (label, prefix, ext, mime) => {
    const { app, downloads, status } = await open();
    (byText(app, label).querySelector("input") as HTMLInputElement).click();
    (app.querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;
    await click(byText(app, "Pobierz plik"));
    const day = new Date().toISOString().slice(0, 10);
    expect(downloads).toEqual([{ name: `${prefix}-${day}.${ext}`, type: mime }]);
    expect(status().textContent).toBe("Wyeksportowano 0 wpisów. Usuń plik, gdy nie będzie już potrzebny.");
  });

  it("shows an export failure (locked vault) as an error and downloads nothing", async () => {
    const { app, store, downloads, status } = await open();
    await store.lock();
    (app.querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;
    await click(byText(app, "Pobierz plik"));
    expect(downloads).toEqual([]);
    expect(status().textContent).toBe("Sejf jest zablokowany");
    expect(status().classList.contains("error")).toBe(true);
  });

  it("imports a PassHolder file", async () => {
    const { app, status } = await open();
    chooseFile(app, sample);
    await click(byText(app, "Importuj"));
    await settle(() => status().textContent!.startsWith("Dodano"));
    expect(status().textContent).toContain("Dodano 5 wpisów");
    expect(status().classList.contains("error")).toBe(false);
  });

  it("shows a broken file as an error", async () => {
    const { app, status } = await open();
    chooseFile(app, "{ to nie jest JSON");
    await click(byText(app, "Importuj"));
    await settle(() => status().classList.contains("error"));
    expect(status().textContent).not.toBe("");
  });
});
