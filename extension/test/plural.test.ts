import { describe, expect, it } from "vitest";
import { entriesNoun, filesNoun, skippedFilesPhrase, plural } from "../src/plural.ts";

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
  it("skippedFilesPhrase agrees the verb", () => {
    expect([1, 2, 5, 12, 22, 25].map(skippedFilesPhrase)).toEqual([
      "1 plik nie zostanie wyeksportowany", "2 pliki nie zostaną wyeksportowane", "5 plików nie zostanie wyeksportowanych",
      "12 plików nie zostanie wyeksportowanych", "22 pliki nie zostaną wyeksportowane", "25 plików nie zostanie wyeksportowanych",
    ]);
  });
  it("filesNoun", () => {
    expect([1, 3, 5].map(filesNoun)).toEqual(["1 plik", "3 pliki", "5 plików"]);
  });
});
