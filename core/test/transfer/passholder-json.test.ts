import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  exportPassHolderJson, isPassHolderJson, parsePassHolderJson, sortForExport, type ParsedImport,
} from "../../src/transfer/index.ts";

const read = (name: string) => readFileSync(new URL(`../../test-vectors/transfer/${name}`, import.meta.url), "utf8");
const file = read("passholder.json");
const expected = JSON.parse(read("passholder.expected.json")) as ParsedImport;

describe("parsePassHolderJson", () => {
  it("matches the shared sample file", () => {
    expect(parsePassHolderJson(file)).toEqual(expected);
  });

  it("covers every entry type in the sample", () => {
    expect(expected.entries.map((e) => e.type)).toEqual(["login", "contact", "card", "note", "document"]);
  });

  it("rejects other versions, formats and shapes", () => {
    const msg = "To nie jest plik PassHolder w wersji 3";
    expect(() => parsePassHolderJson(JSON.stringify({ format: "passholder", version: 2, entries: [] }))).toThrow(msg);
    expect(() => parsePassHolderJson(JSON.stringify({ format: "other", version: 3, entries: [] }))).toThrow(msg);
    expect(() => parsePassHolderJson(JSON.stringify({ format: "passholder", version: 3, entries: {} }))).toThrow(msg);
    expect(() => parsePassHolderJson("[]")).toThrow(msg);
    expect(() => parsePassHolderJson("null")).toThrow(msg);
  });

  it("skips an entry with an unknown key by its position in the file and keeps the rest", () => {
    const r = parsePassHolderJson(file);
    expect(r.skipped[0]).toEqual({ at: "wpis 6", reason: "zły format wpisu" });
    expect(r.entries).toHaveLength(5);
  });

  it("skips an entry with an empty or blank name as \"brak nazwy\"", () => {
    const entry = { type: "note", note: "", fields: {}, custom: [] };
    const text = JSON.stringify({ format: "passholder", version: 3, entries: [{ ...entry, name: "  " }, { ...entry, name: "" }, { ...entry, name: "Ok" }] });
    expect(parsePassHolderJson(text)).toEqual({
      entries: [{ ...entry, name: "Ok" }],
      skipped: [{ at: "wpis 1", reason: "brak nazwy" }, { at: "wpis 2", reason: "brak nazwy" }],
    });
  });
});

describe("exportPassHolderJson", () => {
  it("round-trips every entry type, sorted", () => {
    const text = exportPassHolderJson(expected.entries);
    expect(parsePassHolderJson(text)).toEqual({ entries: sortForExport(expected.entries), skipped: [] });
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ format: "passholder", version: 3 });
  });
});

describe("isPassHolderJson", () => {
  it("recognises the format marker", () => {
    expect(isPassHolderJson(JSON.parse(file))).toBe(true);
    expect(isPassHolderJson([])).toBe(false);
    expect(isPassHolderJson(null)).toBe(false);
    expect(isPassHolderJson({ format: "bitwarden" })).toBe(false);
  });
});
