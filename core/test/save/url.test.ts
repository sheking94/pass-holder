import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchUrl } from "../../src/autofill/match.ts";
import { saveName, saveUrl } from "../../src/save/url.ts";

const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/save/url.json", import.meta.url), "utf8")) as {
  cases: { page: string; expected: string | null; name: string | null; why: string }[];
};

describe("saveUrl vectors", () => {
  for (const c of vectors.cases) {
    it(`${c.page}: ${c.why}`, () => {
      expect(saveUrl(c.page)).toBe(c.expected);
      if (c.expected !== null) {
        expect(saveName(c.expected)).toBe(c.name);
        expect(matchUrl(c.page, c.expected)).toBe("exact");
      }
    });
  }
});
