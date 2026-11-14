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

function chooseFile(app: Element, data: string | Uint8Array | File, name = "x.json") {
  const input = app.querySelector<HTMLInputElement>("input[type=file]")!;
  const file = data instanceof File ? data : new File([data as BlobPart], name);
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  return file;
}

const PLAIN_WARNING = "Uwaga: plik nie jest zaszyfrowany. Każdy, kto go zobaczy (inny program, kopia zapasowa, synchronizacja folderu Pobrane z chmurą), pozna wszystkie Twoje hasła. Usuń go zaraz po użyciu.";
const ZIP_WARNING = "Uwaga: archiwum nie jest zaszyfrowane. Zawiera hasła jawnym tekstem i odszyfrowane pliki. Każdy, kto je zobaczy (inny program, kopia zapasowa, folder w chmurze), pozna je wszystkie. Usuń je zaraz po użyciu.";

describe("transfer view", () => {
  it("shows the title, intro and four formats with PassHolder JSON selected", async () => {
    const { app } = await open();
    expect(app.querySelector("h1")!.textContent).toBe("Import i eksport");
    expect(app.textContent).toContain("Import rozpoznaje format sam: PassHolder ZIP, PassHolder JSON, Bitwarden JSON (bez szyfrowania) albo NordPass CSV.");
    const radios = [...app.querySelectorAll<HTMLInputElement>("input[type=radio][name=format]")];
    expect(radios.map((r) => r.value)).toEqual(["passholder", "passholder-zip", "bitwarden", "nordpass"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
    expect(byText(app, "PassHolder ZIP (wpisy i pliki)").querySelector("input")!.value).toBe("passholder-zip");
    expect(app.querySelector("input[type=file]")!.getAttribute("accept")).toBe(".json,.csv,.zip,application/json,text/csv,application/zip");
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

  it("tells how many attachments the export leaves out", async () => {
    const ctx = await setupPopup();
    const { store } = ctx;
    const att = (id: string) => ({ id, name: "a.pdf", size: 1, key: "k", chunks: 1 });
    vi.spyOn(store, "allContents").mockReturnValue([
      { type: "login", name: "A", attachments: [att("1"), att("2")] },
    ] as never);
    const { transferView } = await import("../../src/views/transfer.ts");
    transferView();
    expect(ctx.app.textContent).toContain("2 pliki nie zostaną wyeksportowane w formatach JSON i CSV. Wybierz PassHolder ZIP, żeby je zabrać.");
  });

  it("says nothing about files when the vault has no attachments", async () => {
    const { app } = await open();
    expect(app.textContent).not.toContain("nie zostaną wyeksportowane");
  });

  it("shows a broken file as an error", async () => {
    const { app, status } = await open();
    chooseFile(app, "{ to nie jest JSON");
    await click(byText(app, "Importuj"));
    await settle(() => status().classList.contains("error"));
    expect(status().textContent).not.toBe("");
  });

  it("shows the archive warning instead of the plain one while PassHolder ZIP is chosen", async () => {
    const { app } = await open();
    const warning = () => app.querySelector(".warning")!.textContent;
    expect(warning()).toBe(PLAIN_WARNING);
    (byText(app, "PassHolder ZIP (wpisy i pliki)").querySelector("input") as HTMLInputElement).click();
    expect(warning()).toBe(ZIP_WARNING);
    expect(app.querySelectorAll(".warning")).toHaveLength(1);
    (byText(app, "NordPass CSV").querySelector("input") as HTMLInputElement).click();
    expect(warning()).toBe(PLAIN_WARNING);
  });

  it("exports a PassHolder ZIP and says how many entries and files went out", async () => {
    const { app, store, downloads, status } = await open();
    vi.spyOn(store, "exportArchive").mockResolvedValue({ parts: [new Uint8Array([1])], entries: 3, files: 2, missing: 0 });
    (byText(app, "PassHolder ZIP (wpisy i pliki)").querySelector("input") as HTMLInputElement).click();
    (app.querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;
    await click(byText(app, "Pobierz plik"));
    await settle(() => status().textContent!.startsWith("Wyeksportowano"));
    const day = new Date().toISOString().slice(0, 10);
    expect(downloads).toEqual([{ name: `passholder-${day}.zip`, type: "application/zip" }]);
    expect(status().textContent).toBe("Wyeksportowano 3 wpisy i 2 pliki. Usuń archiwum, gdy nie będzie już potrzebne.");
  });

  it("tells how many files the ZIP export left out", async () => {
    const { app, store, status } = await open();
    vi.spyOn(store, "exportArchive").mockResolvedValue({ parts: [], entries: 1, files: 0, missing: 1 });
    (byText(app, "PassHolder ZIP (wpisy i pliki)").querySelector("input") as HTMLInputElement).click();
    (app.querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;
    await click(byText(app, "Pobierz plik"));
    await settle(() => status().textContent!.startsWith("Wyeksportowano"));
    expect(status().textContent).toBe(
      "Wyeksportowano 1 wpis. Pominięto 1 plik, który czeka na synchronizację albo jest uszkodzony. Usuń archiwum, gdy nie będzie już potrzebne.",
    );
  });

  it("imports a chosen ZIP file as a PassHolder archive", async () => {
    const { app, store, status } = await open();
    const { concat, transfer } = await import("@passholder/core");
    const { parts } = await transfer.exportPassHolderZip(
      [{ type: "note", name: "Notatka", note: "x", custom: [], fields: {} }],
      async () => undefined,
    );
    const importArchive = vi.spyOn(store, "importArchive");
    chooseFile(app, concat(...parts), "kopia.zip");
    await click(byText(app, "Importuj"));
    await settle(() => status().textContent!.startsWith("Dodano"));
    expect(importArchive).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe("Dodano 1 wpis (lokalnie, zsynchronizuj, żeby trafiły na telefon). Usuń plik z dysku, zawiera hasła jawnym tekstem.");
  });

  it("refuses a file over 256 MiB without reading it", async () => {
    const { app, status } = await open();
    const file = new File(["{}"], "duzy.zip");
    Object.defineProperty(file, "size", { value: 268435457 });
    const read = vi.spyOn(file, "arrayBuffer");
    const text = vi.spyOn(file, "text");
    chooseFile(app, file);
    await click(byText(app, "Importuj"));
    await settle(() => status().classList.contains("error"));
    expect(status().textContent).toBe("Plik jest za duży (limit 256 MiB)");
    expect(read).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("lists files described in a bare passholder.json as skipped", async () => {
    const { app, status } = await open();
    const index = JSON.stringify({
      format: "passholder",
      version: 3,
      entries: [{ type: "note", name: "N", note: "", custom: [], fields: {}, attachments: [{ name: "a.pdf", mime: "application/pdf", size: 5, path: "files/1-a.pdf" }] }],
    });
    chooseFile(app, index, "passholder.json");
    await click(byText(app, "Importuj"));
    await settle(() => status().textContent!.startsWith("Dodano"));
    expect(status().textContent).toContain("Pominięto 1 plik: wpis 1, a.pdf: importuj całe archiwum ZIP.");
  });
});
