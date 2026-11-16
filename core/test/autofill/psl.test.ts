import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicSuffix, registrableDomain } from "../../src/autofill/psl.ts";
import { PSL_RULES } from "../../src/autofill/psl-rules.ts";

const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/autofill/psl.json", import.meta.url), "utf8")) as {
  cases: { host: string; publicSuffix: string; registrableDomain: string | null }[];
};

describe("public suffix vectors", () => {
  for (const c of vectors.cases) {
    it(c.host, () => {
      expect(publicSuffix(c.host)).toBe(c.publicSuffix);
      expect(registrableDomain(c.host) ?? null).toBe(c.registrableDomain);
    });
  }
});

describe("public suffix rules", () => {
  it("the Kotlin resource has the same rules", () => {
    const kotlin = readFileSync(
      new URL("../../../android/core/src/main/resources/io/github/sheking94/passholder/core/autofill/public_suffix_rules.txt", import.meta.url),
      "utf8",
    );
    const rules = kotlin.split("\n").filter((l) => l !== "" && !l.startsWith("//"));
    expect(rules.join("\n")).toBe(PSL_RULES);
  });

  it("rules are ASCII, lowercase and without blanks", () => {
    expect(PSL_RULES.split("\n").every((r) => /^(\*\.|!)?[a-z0-9_.-]+$/.test(r))).toBe(true);
  });
});
