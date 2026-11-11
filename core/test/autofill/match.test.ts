import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchLogins, matchUrl } from "../../src/autofill/match.ts";

const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/autofill/match.json", import.meta.url), "utf8")) as {
  cases: { page: string; saved: string; expected: "exact" | "subdomain" | null; why: string }[];
};

describe("matchUrl vectors", () => {
  for (const c of vectors.cases) {
    it(`${c.page} vs ${c.saved}: ${c.why}`, () => {
      expect(matchUrl(c.page, c.saved) ?? null).toBe(c.expected);
    });
  }
});

describe("matchLogins", () => {
  const id = (x: { name: string; urls: string[] }) => x;

  it("filters and sorts exact before subdomain, then by name", () => {
    const items = [
      { name: "B", urls: ["mail.google.com"] },
      { name: "A", urls: ["google.com"] },
      { name: "C", urls: ["x.pl"] },
    ];
    expect(matchLogins("https://mail.google.com", items, id).map((x) => x.name)).toEqual(["B", "A"]);
  });

  it("sorts by name within a group using Polish collation", () => {
    const items = [
      { name: "Zebra", urls: ["a.pl"] },
      { name: "Łoś", urls: ["a.pl"] },
      { name: "Lis", urls: ["a.pl"] },
    ];
    expect(matchLogins("https://a.pl", items, id).map((x) => x.name)).toEqual(["Lis", "Łoś", "Zebra"]);
  });

  it("uses the best match among several addresses", () => {
    const items = [
      { name: "Multi", urls: ["google.com", "mail.google.com"] },
      { name: "Aaa", urls: ["google.com"] },
    ];
    expect(matchLogins("https://mail.google.com", items, id).map((x) => x.name)).toEqual(["Multi", "Aaa"]);
  });

  it("returns an empty list for non-http pages", () => {
    expect(matchLogins("chrome://settings", [{ name: "S", urls: ["settings"] }], id)).toEqual([]);
  });
});
