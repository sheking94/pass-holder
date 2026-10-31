import { describe, expect, it } from "vitest";
import { CHARACTER_GROUPS, generatePassword, randomIndex } from "../src/generator.ts";

describe("password generator", () => {
  it("respects length and includes every chosen group", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword({ length: 8, groups: ["lowercase", "digits", "symbols"] });
      expect(pw).toHaveLength(8);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect([...pw].some((c) => CHARACTER_GROUPS.symbols.includes(c))).toBe(true);
      expect(pw).not.toMatch(/[A-Z]/);
    }
  });

  it("rejects invalid options", () => {
    expect(() => generatePassword({ length: 20, groups: [] })).toThrow();
    expect(() => generatePassword({ length: 3, groups: ["digits"] })).toThrow();
    expect(() => generatePassword({ length: 129, groups: ["digits"] })).toThrow();
  });

  it("picks indices roughly uniformly", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) counts[randomIndex(10)]++;
    for (const c of counts) expect(c).toBeGreaterThan(1700);
  });
});
