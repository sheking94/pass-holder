import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideSave, newLogin, withPassword, type SaveDecision, type SavedLogin } from "../../src/save/decide.ts";

const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/save/decide.json", import.meta.url), "utf8")) as {
  cases: { username: string; password: string; logins: SavedLogin[]; expected: SaveDecision; why: string }[];
};

describe("decideSave vectors", () => {
  for (const c of vectors.cases) {
    it(c.why, () => {
      expect(decideSave(c.username, c.password, c.logins)).toEqual(c.expected);
    });
  }
});

describe("newLogin", () => {
  it("builds a login named after the host", () => {
    const e = newLogin("http://localhost:3000", "a", "b");
    expect(e.type).toBe("login");
    expect(e.name).toBe("localhost");
    expect(e.fields).toEqual({ username: "a", password: "b", totp: "", urls: ["http://localhost:3000"], androidApps: [] });
    expect(e.note).toBe("");
    expect(e.custom).toEqual([]);
  });
});

describe("withPassword", () => {
  it("changes only the password", () => {
    const e = newLogin("github.com", "a", "b");
    e.note = "n";
    e.custom = [{ label: "k", value: "v" }] as typeof e.custom;
    const u = withPassword(e, "c");
    expect(u.fields.password).toBe("c");
    expect(u.note).toBe("n");
    expect(u.custom).toEqual(e.custom);
    expect(u.fields.urls).toEqual(["github.com"]);
    expect(e.fields.password).toBe("b");
  });
});
