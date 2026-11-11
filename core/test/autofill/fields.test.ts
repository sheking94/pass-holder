import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyField, type FieldDescriptor } from "../../src/autofill/fields.ts";
import { normalizeText, type FieldKind } from "../../src/autofill/keywords.ts";

const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/autofill/fields.json", import.meta.url), "utf8")) as {
  cases: { field: Partial<FieldDescriptor>; expected: FieldKind | null }[];
};

const full = (p: Partial<FieldDescriptor>): FieldDescriptor => ({
  autocomplete: [], type: "", name: "", id: "", label: "", placeholder: "", ...p,
});

describe("classifyField vectors", () => {
  for (const c of vectors.cases) {
    it(`${JSON.stringify(c.field)} -> ${c.expected}`, () => {
      expect(classifyField(full(c.field))).toBe(c.expected);
    });
  }
});

describe("normalizeText", () => {
  it("lowercases and strips Polish diacritics", () => {
    expect(normalizeText("Łódź Ważność")).toBe("lodz waznosc");
  });
});
