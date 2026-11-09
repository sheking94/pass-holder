import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { p2p, transfer } from "@passholder/core";
import { importSummary } from "../src/import-summary.ts";
import { pairedBrowser } from "./fake-phone.ts";

const read = (name: string) => readFileSync(new URL(`../../core/test-vectors/transfer/${name}`, import.meta.url), "utf8");
const TYPES: p2p.EntryType[] = ["login", "contact", "card", "note", "document"];

function ids() {
  let n = 0;
  return () => `new-${++n}`;
}

describe("VaultStore.importContents", () => {
  it("imports every entry type from a PassHolder file", async () => {
    const { store } = await pairedBrowser();
    const { parsed } = transfer.parseImportFile(read("passholder.json"));
    const result = await store.importContents(parsed.entries, ids());
    expect(result).toEqual({ added: parsed.entries.length, duplicates: 0, tooLarge: 0 });
    for (const type of TYPES) expect(store.listEntries(type).length).toBeGreaterThan(0);
    expect(store.allContents().length).toBe(parsed.entries.length);
  }, 30_000);

  it("a second import of the same file adds nothing and counts every entry as a duplicate", async () => {
    const { store } = await pairedBrowser();
    const { parsed } = transfer.parseImportFile(read("passholder.json"));
    await store.importContents(parsed.entries, ids());
    const again = await store.importContents(parsed.entries, ids());
    expect(again).toEqual({ added: 0, duplicates: parsed.entries.length, tooLarge: 0 });
    expect(store.allContents().length).toBe(parsed.entries.length);
  }, 30_000);

  it("skips duplicates within the file and in the vault (login), keeps one that differs", async () => {
    const { store, phone } = await pairedBrowser();
    await store.upsert("1", { name: "Bank", username: "jan", password: "x" });
    const login = (password: string): p2p.EntryContentV3 => ({
      ...p2p.emptyLogin("Bank"),
      fields: { ...p2p.emptyLogin("Bank").fields, username: "jan", password },
    } as p2p.EntryContentV3);
    const poczta = { ...login("y"), name: "Poczta" };
    const result = await store.importContents([login("x"), login("nowe"), poczta, poczta], ids());
    expect(result).toEqual({ added: 2, duplicates: 2, tooLarge: 0 });
    expect(store.entries().map((e) => e.data.password).sort()).toEqual(["nowe", "x", "y"]);
    expect(store.pendingCount()).toBe(3);
    await store.sync();
    expect(store.pendingCount()).toBe(0);
    expect(await phone.entryNames()).toEqual(["Bank", "Bank", "Poczta"]);
  }, 30_000);

  it("treats an entry that differs only in the note as new, and ignores edge spaces", async () => {
    const { store } = await pairedBrowser();
    const { parsed } = transfer.parseImportFile(read("passholder.json"));
    await store.importContents(parsed.entries, ids());
    const first = parsed.entries[0]!;
    const spaced = { ...first, name: ` ${first.name} ` };
    expect((await store.importContents([spaced], ids())).duplicates).toBe(1);
    const noted = { ...first, note: first.note + " dopisek" };
    expect(await store.importContents([noted], ids())).toEqual({ added: 1, duplicates: 0, tooLarge: 0 });
  }, 30_000);

  it("a deleted entry does not count as a duplicate", async () => {
    const { store } = await pairedBrowser();
    const { parsed } = transfer.parseImportFile(read("passholder.json"));
    const one = parsed.entries.slice(0, 1);
    await store.importContents(one, () => "a");
    await store.delete("a");
    expect(await store.importContents(one, () => "b")).toEqual({ added: 1, duplicates: 0, tooLarge: 0 });
  }, 30_000);

  it("counts an entry over 64 KiB as too large and still imports the rest", async () => {
    const { store } = await pairedBrowser();
    const big: p2p.EntryContentV3 = { ...p2p.emptyLogin("big"), note: "x".repeat(70_000) } as p2p.EntryContentV3;
    const { parsed } = transfer.parseImportFile(read("passholder.json"));
    const result = await store.importContents([big, parsed.entries[0]!], ids());
    expect(result).toEqual({ added: 1, duplicates: 0, tooLarge: 1 });
  }, 30_000);

  it("a file that fails to parse leaves the vault unchanged", async () => {
    const { store } = await pairedBrowser();
    await store.upsert("1", { name: "Bank", username: "jan", password: "x" });
    expect(() => transfer.parseImportFile("{zły")).toThrow("Plik JSON jest uszkodzony");
    expect(() => transfer.parseImportFile("foo,bar\n1,2")).toThrow(/NordPass/);
    expect(store.allContents().length).toBe(1);
    expect(store.pendingCount()).toBe(1);
  }, 30_000);

  it("allContents has live entries only, without v and hlc", async () => {
    const { store } = await pairedBrowser();
    await store.upsert("1", { name: "A", username: "u", password: "p" });
    await store.upsert("2", { name: "B", username: "u", password: "p" });
    await store.delete("2");
    const all = store.allContents();
    expect(all.map((c) => c.name)).toEqual(["A"]);
    expect(Object.keys(all[0]!).sort()).toEqual(["custom", "fields", "name", "note", "type"]);
  }, 30_000);
});

describe("importSummary", () => {
  const none = { entries: [], skipped: [] };
  const done = "Usuń plik z dysku, zawiera hasła jawnym tekstem.";

  it("mentions entries skipped as too large only when there are some", () => {
    expect(importSummary(none, { added: 0, duplicates: 0, tooLarge: 2 }, "nordpass")).toContain("pominięto za duże: 2");
    expect(importSummary(none, { added: 0, duplicates: 0, tooLarge: 0 }, "nordpass")).not.toContain("za duże");
  });

  it("says only what was added when nothing was skipped", () => {
    expect(importSummary(none, { added: 2, duplicates: 0, tooLarge: 0 }, "bitwarden")).toBe(
      `Dodano 2 wpisy (lokalnie, zsynchronizuj, żeby trafiły na telefon). ${done}`,
    );
  });

  it("uses the right plural for added and skipped", () => {
    expect(importSummary(none, { added: 1, duplicates: 0, tooLarge: 0 }, "nordpass")).toContain("Dodano 1 wpis (");
    expect(importSummary(none, { added: 5, duplicates: 0, tooLarge: 0 }, "nordpass")).toContain("Dodano 5 wpisów (");
    const one = importSummary({ entries: [], skipped: [{ at: "wiersz 2", reason: "x" }] }, { added: 0, duplicates: 0, tooLarge: 0 }, "nordpass");
    expect(one).toContain("Pominięto 1 wiersz:");
    const three = importSummary({ entries: [], skipped: [2, 3, 4].map((n) => ({ at: `wiersz ${n}`, reason: "x" })) }, { added: 0, duplicates: 0, tooLarge: 0 }, "nordpass");
    expect(three).toContain("Pominięto 3 wiersze:");
  });

  it("lists duplicates and up to five skipped items", () => {
    const skipped = [2, 3, 4, 5, 6, 7].map((n) => ({ at: `wiersz ${n}`, reason: "brak hasła" }));
    const text = importSummary({ entries: [], skipped }, { added: 1, duplicates: 3, tooLarge: 0 }, "nordpass");
    expect(text).toContain("Pominięto 3 takich, które już są w sejfie.");
    expect(text).toContain("Pominięto 6 wierszy: wiersz 2: brak hasła; wiersz 3: brak hasła; wiersz 4: brak hasła; wiersz 5: brak hasła; wiersz 6: brak hasła; …");
    expect(text).not.toContain("wiersz 7");
    expect(importSummary({ entries: [], skipped: skipped.slice(0, 1) }, { added: 0, duplicates: 0, tooLarge: 0 }, "nordpass")).toContain("wiersz 2: brak hasła.");
    expect(text.endsWith(done)).toBe(true);
  });
});

describe("importSummary for JSON formats", () => {
  it("calls skipped items entries, not rows", () => {
    const text = importSummary({ entries: [], skipped: [{ at: "wpis 2", reason: "zły typ" }] }, { added: 0, duplicates: 0, tooLarge: 0 }, "passholder");
    expect(text).toContain("Pominięto 1 wpis: wpis 2: zły typ.");
  });
});
