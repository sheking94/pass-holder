import { describe, expect, it } from "vitest";
import { entriesNoun, plural } from "../src/plural.ts";

describe("plural", () => {
  const w = (n: number) => plural(n, "wpis", "wpisy", "wpisów");
  it("picks the Polish form", () => {
    expect([0, 1, 2, 4, 5, 11, 12, 14, 15, 21, 22, 24, 25, 101, 112, 122].map(w)).toEqual([
      "wpisów", "wpis", "wpisy", "wpisy", "wpisów", "wpisów", "wpisów", "wpisów", "wpisów", "wpisów", "wpisy", "wpisy", "wpisów", "wpisów", "wpisów", "wpisy",
    ]);
  });
  it("entriesNoun", () => {
    expect(entriesNoun(3)).toBe("3 wpisy");
  });
});
