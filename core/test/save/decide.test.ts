import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideSave, newLogin, PREVIOUS_PASSWORD_LABEL, withPassword, type SaveDecision, type SavedLogin } from "../../src/save/decide.ts";

const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/save/decide.json", import.meta.url), "utf8")) as {
  cases: { username: string; password: string; logins: SavedLogin[]; related?: SavedLogin[]; expected: SaveDecision; why: string }[];
};

describe("decideSave vectors", () => {
  for (const c of vectors.cases) {
    it(c.why, () => {
      expect(decideSave(c.username, c.password, c.logins, c.related)).toEqual(c.expected);
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
  it("changes the password and keeps the old one in a hidden custom field", () => {
    const e = newLogin("github.com", "a", "b");
    e.note = "n";
    e.custom = [{ label: "k", value: "v", hidden: false }];
    const u = withPassword(e, "c");
    expect(u.fields.password).toBe("c");
    expect(u.note).toBe("n");
    expect(u.custom).toEqual([{ label: "k", value: "v", hidden: false }, { label: PREVIOUS_PASSWORD_LABEL, value: "b", hidden: true }]);
    expect(u.fields.urls).toEqual(["github.com"]);
    expect(e.fields.password).toBe("b");
    expect(e.custom).toHaveLength(1);
  });

  it("keeps only the latest previous password", () => {
    const u = withPassword(withPassword(newLogin("github.com", "a", "one"), "two"), "three");
    expect(u.custom).toEqual([{ label: PREVIOUS_PASSWORD_LABEL, value: "two", hidden: true }]);
  });

  it("adds nothing for an empty or unchanged password", () => {
    expect(withPassword(newLogin("github.com", "a", ""), "x").custom).toEqual([]);
    expect(withPassword(newLogin("github.com", "a", "x"), "x").custom).toEqual([]);
  });
});
