// @vitest-environment happy-dom
import type { p2p } from "@passholder/core";
import type * as files from "@passholder/core/files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyContent } from "../../src/entry-types.ts";
import { byText, click, settle, setupPopup, teardownPopup } from "./fake-chrome.ts";

afterEach(() => {
  teardownPopup();
  history.replaceState({}, "", "/");
});

const SAVED = "Zapisano lokalnie. Zsynchronizuj, gdy telefon będzie w trybie Synchronizacja.";
const DOWNLOAD_WARNING = "Pobierasz plik, który zostanie odszyfrowany i będzie dostępny na tym urządzeniu.";
const TAB_WARNING =
  "Formularz otworzy się w karcie. Niezapisane zmiany z tego okna przepadną – najpierw zapisz wpis, jeśli coś zmieniłeś.";

const status = (app: Element) => app.querySelector(".status")?.textContent;
const rows = (app: Element) => [...app.querySelectorAll<HTMLElement>("li.attachment")];
const rowText = (row: HTMLElement) => row.textContent;

function doc(name = "Dowód"): p2p.EntryContentV3 {
  return { ...emptyContent("document"), name } as p2p.EntryContentV3;
}

/** A valid descriptor of a file this browser does not have (as if added on the phone). */
function remoteAttachment(name = "skan.pdf"): files.Attachment {
  return { id: crypto.randomUUID(), name, mime: "application/pdf", size: 1000, chunks: 1, sha256: "0".repeat(64), key: btoa("\0".repeat(32)) };
}

function chooseFile(app: Element, file: File) {
  const input = app.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change"));
}

async function addFile(app: Element, file: File) {
  const before = rows(app).length;
  chooseFile(app, file);
  await settle(() => rows(app).length === before + 1);
}

async function save(app: Element) {
  await click(byText(app, "Zapisz"));
  await settle(() => app.querySelector(".status")?.textContent === SAVED);
}

const photo = () => new File([new Uint8Array([1, 2, 3, 4, 5])], "dowod.jpg", { type: "image/jpeg" });

/** The page as a tab (the file chooser works there). */
async function inTab(entries: { id: string; content: p2p.EntryContentV3 }[] = []) {
  history.replaceState({}, "", "/?tab");
  const ctx = await setupPopup(entries);
  const { editView } = await import("../../src/views/edit.ts");
  return { ...ctx, editView };
}

function captureDownloads() {
  const downloads: { name: string; type: string; size: number }[] = [];
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const b = blob as Blob;
    return `blob:${b.type}|${b.size}`;
  };
  URL.revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const [type, size] = this.href.replace(/^blob:/, "").split("|");
    downloads.push({ name: this.download, type: type!, size: Number(size) });
  });
  return downloads;
}

describe("attachments section in a tab", () => {
  it("a chosen file is a new row until „Zapisz” stores it with the entry", async () => {
    const { app, store, editView } = await inTab();
    await editView("document");
    expect(byText(app, "+ Dodaj plik")).toBeTruthy();
    (app.querySelector("input") as HTMLInputElement).value = "Dowód";
    await addFile(app, photo());
    const [row] = rows(app);
    expect(rowText(row!)).toContain("dowod.jpg");
    expect(rowText(row!)).toContain("1 KB");
    expect(rowText(row!)).toContain("nowy – zapisz wpis");
    expect((byText(row!, "Pobierz") as HTMLButtonElement).disabled).toBe(true);
    await save(app);
    const [entry] = store.listEntries("document");
    expect(entry!.data.attachments).toHaveLength(1);
    const a = entry!.data.attachments![0]!;
    expect(a).toMatchObject({ name: "dowod.jpg", mime: "image/jpeg", size: 5 });
    expect(await store.fileStatus(a)).toBe("ready");
    expect([...(await store.readFile(a))]).toEqual([1, 2, 3, 4, 5]);
  }, 30_000);

  it("refuses the 21st file", async () => {
    const { app, editView } = await inTab();
    await editView("document");
    for (let i = 0; i < 20; i++) await addFile(app, new File([new Uint8Array([i + 1])], `plik${i}.txt`, { type: "text/plain" }));
    chooseFile(app, photo());
    await settle(() => status(app) === "Najwyżej 20 plików we wpisie");
    expect(app.querySelector(".status")!.classList.contains("error")).toBe(true);
    expect(rows(app)).toHaveLength(20);
  }, 30_000);

  it("refuses a file over 10 MB, an empty file and a bad name", async () => {
    const { app, editView } = await inTab();
    await editView("document");
    chooseFile(app, new File([new Uint8Array(10485761)], "duzy.bin"));
    await settle(() => status(app) === "Plik jest za duży (limit 10 MB)");
    chooseFile(app, new File([], "pusty.txt"));
    await settle(() => status(app) === "Plik jest pusty");
    chooseFile(app, new File([new Uint8Array([1])], "a\u0001b.txt"));
    await settle(() => status(app) === "Nieprawidłowa nazwa pliku");
    expect(rows(app)).toHaveLength(0);
  }, 30_000);

  it("the same file chosen twice gives two attachments with different ids, both readable", async () => {
    const { app, store, editView } = await inTab();
    await editView("document");
    (app.querySelector("input") as HTMLInputElement).value = "Dowód";
    const file = photo();
    await addFile(app, file);
    await addFile(app, file);
    await save(app);
    const list = store.listEntries("document")[0]!.data.attachments!;
    expect(list).toHaveLength(2);
    expect(list[0]!.id).not.toBe(list[1]!.id);
    for (const a of list) expect([...(await store.readFile(a))]).toEqual([1, 2, 3, 4, 5]);
  }, 30_000);

  it("„Usuń” takes the file off the form; „Zapisz” saves the entry without it", async () => {
    const { app, store, editView } = await inTab([{ id: "d1", content: doc() }]);
    await editView("document", "d1");
    await addFile(app, photo());
    await save(app);
    expect(store.getEntry("d1")!.data.attachments).toHaveLength(1);
    await editView("document", "d1");
    await settle(() => rows(app).length === 1);
    await click(byText(rows(app)[0]!, "Usuń"));
    expect(rows(app)).toHaveLength(0);
    expect(store.getEntry("d1")!.data.attachments).toHaveLength(1);
    await save(app);
    expect(store.getEntry("d1")!.data.attachments ?? []).toHaveLength(0);
    expect("attachments" in store.getEntry("d1")!.data).toBe(false);
  }, 30_000);

  it("„Pobierz” asks first; „Anuluj” downloads nothing, „Pobierz” saves the decrypted file", async () => {
    const downloads = captureDownloads();
    const { app, editView } = await inTab([{ id: "d1", content: doc() }]);
    await editView("document", "d1");
    await addFile(app, photo());
    await save(app);
    await editView("document", "d1");
    await settle(() => rows(app).length === 1);
    // Saved here but not yet on the phone.
    expect(rowText(rows(app)[0]!)).toContain("czeka na synchronizację");
    await click(byText(rows(app)[0]!, "Pobierz"));
    const box = () => app.querySelector<HTMLElement>(".confirm-box");
    expect(box()!.textContent).toContain(DOWNLOAD_WARNING);
    await click(byText(box()!, "Anuluj"));
    expect(box()).toBeNull();
    expect(downloads).toEqual([]);
    await click(byText(rows(app)[0]!, "Pobierz"));
    await click(byText(box()!, "Pobierz"));
    await settle(() => downloads.length === 1);
    expect(downloads).toEqual([{ name: "dowod.jpg", type: "image/jpeg", size: 5 }]);
    expect(box()).toBeNull();
  }, 30_000);

  it("a file not here yet waits for a sync, a corrupted one says so; neither can be downloaded", async () => {
    const waiting = remoteAttachment("skan.pdf");
    const broken = remoteAttachment("zly.pdf");
    const { app, editView, local } = await inTab([{ id: "d1", content: { ...doc(), attachments: [waiting, broken] } }]);
    await local.set({ corruptFiles: [broken.id] });
    await editView("document", "d1");
    await settle(() => rows(app).length === 2);
    const [first, second] = rows(app);
    expect(rowText(first!)).toContain("czeka na synchronizację");
    expect(rowText(second!)).toContain("Plik jest uszkodzony");
    expect((byText(first!, "Pobierz") as HTMLButtonElement).disabled).toBe(true);
    expect((byText(second!, "Pobierz") as HTMLButtonElement).disabled).toBe(true);
  }, 30_000);
});

describe("attachments section in the popup", () => {
  it("„+ Dodaj plik” warns first; „Anuluj” stays, „Otwórz w karcie” opens the form in a tab", async () => {
    const { app, createdTabs, close } = await setupPopup([{ id: "d1", content: doc() }]);
    const { editView } = await import("../../src/views/edit.ts");
    await editView("document", "d1");
    expect(app.querySelector('input[type="file"]')).toBeNull();
    await click(byText(app, "+ Dodaj plik"));
    const box = () => app.querySelector<HTMLElement>(".confirm-box");
    expect(box()!.textContent).toContain(TAB_WARNING);
    await click(byText(box()!, "Anuluj"));
    expect(box()).toBeNull();
    expect(createdTabs).toEqual([]);
    await click(byText(app, "+ Dodaj plik"));
    await click(byText(box()!, "Otwórz w karcie"));
    expect(createdTabs).toEqual(["chrome-extension://passholder/popup.html?edit&type=document&id=d1"]);
    expect(close).toHaveBeenCalled();
  }, 30_000);

  it("for a new entry the tab opens the empty form of that type", async () => {
    const { app, createdTabs } = await setupPopup();
    const { editView } = await import("../../src/views/edit.ts");
    await editView("note");
    await click(byText(app, "+ Dodaj plik"));
    await click(byText(app.querySelector(".confirm-box")!, "Otwórz w karcie"));
    expect(createdTabs).toEqual(["chrome-extension://passholder/popup.html?edit&type=note"]);
  }, 30_000);
});

describe("edit tab", () => {
  it("shows the entry's form once unlocked", async () => {
    history.replaceState({}, "", "/?edit&type=document&id=d1");
    const { app } = await setupPopup([{ id: "d1", content: doc("Paszport") }]);
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.querySelector("h1")?.textContent === "Edytuj dokument");
    expect((app.querySelector("input") as HTMLInputElement).value).toBe("Paszport");
    expect(app.querySelector('input[type="file"]')).not.toBeNull();
  }, 30_000);

  it("without an id (or with one that is gone) shows a new form of that type", async () => {
    history.replaceState({}, "", "/?edit&type=card&id=gone");
    const { app } = await setupPopup();
    const { showUnlocked } = await import("../../src/views/locked.ts");
    await showUnlocked();
    await settle(() => app.querySelector("h1")?.textContent === "Nowa karta");
  }, 30_000);
});

describe("list and sync", () => {
  it("the list shows a paperclip with the number of files", async () => {
    const { app, listView } = await (async () => {
      const ctx = await setupPopup([
        { id: "d1", content: { ...doc("Z plikiem"), attachments: [remoteAttachment()] } },
        { id: "d2", content: doc("Bez pliku") },
      ]);
      const { listView } = await import("../../src/views/list.ts");
      return { ...ctx, listView };
    })();
    listView("", false, "document");
    const names = [...app.querySelectorAll("ul.entries .name")].map((n) => n.textContent);
    expect(names.find((n) => n!.startsWith("Z plikiem"))).toContain("📎 1");
    expect(names.find((n) => n!.startsWith("Bez pliku"))).not.toContain("📎");
  }, 30_000);

  it("Synchronizuj shows file progress and how many files went", async () => {
    const { app, editView } = await inTab([{ id: "d1", content: doc() }]);
    await editView("document", "d1");
    await addFile(app, photo());
    await save(app);
    const { listView } = await import("../../src/views/list.ts");
    listView("", false, "document");
    const seen: string[] = [];
    const statusEl = app.querySelector(".status")!;
    new MutationObserver(() => seen.push(statusEl.textContent ?? "")).observe(statusEl, { childList: true, characterData: true, subtree: true });
    await click(byText(app, "Synchronizuj"));
    await settle(() => statusEl.textContent?.startsWith("Zsynchronizowano"));
    expect(statusEl.textContent).toContain(" Pliki: wysłano 1, pobrano 0.");
    expect(statusEl.classList.contains("error")).toBe(false);
    expect(seen).toContain("Pliki: 1 z 1");
  }, 30_000);
});

describe("filesNote", () => {
  const none = { uploaded: 0, downloaded: 0, pending: 0, corrupted: [], corruptedIds: [] };
  it("says nothing when no file moved; adds counts, waiting files, an error and corrupted files; the last two are errors", async () => {
    await setupPopup();
    const { filesNote } = await import("../../src/views/list.ts");
    expect(filesNote(none)).toEqual({ text: "", error: false });
    expect(filesNote({ ...none, uploaded: 2, downloaded: 1 })).toEqual({ text: " Pliki: wysłano 2, pobrano 1.", error: false });
    expect(filesNote({ ...none, pending: 3 })).toEqual({ text: " Nie wszystkie pliki zsynchronizowane (3 czeka).", error: false });
    expect(filesNote({ ...none, error: "Zaktualizuj aplikację na telefonie" })).toEqual({
      text: " Nie wszystkie pliki zsynchronizowane: Zaktualizuj aplikację na telefonie.",
      error: true,
    });
    expect(filesNote({ ...none, downloaded: 1, corrupted: ["a.pdf", "b.jpg"], corruptedIds: ["1", "2"] })).toEqual({
      text: " Pliki: wysłano 0, pobrano 1. Uszkodzone pliki: a.pdf, b.jpg.",
      error: true,
    });
  }, 30_000);
});
