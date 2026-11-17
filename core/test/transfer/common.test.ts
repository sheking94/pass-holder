import { describe, expect, it } from "vitest";
import { contentKey, ENTRY_TYPE_ORDER, sortForExport } from "../../src/transfer/index.ts";
import { emptyLogin, type EntryContent } from "../../src/p2p/index.ts";

const note = (name: string): EntryContent => ({
  type: "note",
  name,
  note: "",
  fields: {},
  custom: [],
});

describe("contentKey", () => {
  it("ignores attachments", () => {
    const a = {
      id: "f1",
      name: "a.pdf",
      mime: "application/pdf",
      size: 1,
      chunks: 1,
      key: "k",
      sha256: "h",
    };
    expect(contentKey({ ...note("A"), attachments: [a] } as EntryContent)).toBe(
      contentKey(note("A")),
    );
  });

  it("ignores key order and outer spaces, not inner differences", () => {
    const a: EntryContent = { type: "note", name: " A ", note: "x", fields: {}, custom: [] };
    const b: EntryContent = { custom: [], fields: {}, note: "x ", name: "A", type: "note" };
    expect(contentKey(a)).toBe(contentKey(b));
    expect(contentKey(a)).not.toBe(contentKey({ ...a, note: "y" }));
    expect(contentKey(a)).not.toBe(contentKey({ ...a, name: "A  B" }));
  });

  it("trims nested texts and distinguishes types and hidden flags", () => {
    const l1 = {
      ...emptyLogin(" n "),
      fields: { username: " u ", password: "p", totp: "", urls: [" https://a "], androidApps: [] },
      custom: [{ label: " l ", value: " v ", hidden: false }],
    };
    const l2 = {
      ...emptyLogin("n"),
      fields: { username: "u", password: "p", totp: "", urls: ["https://a"], androidApps: [] },
      custom: [{ label: "l", value: "v", hidden: false }],
    };
    expect(contentKey(l1)).toBe(contentKey(l2));
    expect(contentKey({ ...l2, custom: [{ label: "l", value: "v", hidden: true }] })).not.toBe(
      contentKey(l2),
    );
    expect(contentKey(note("n"))).not.toBe(contentKey(emptyLogin("n")));
  });
});

describe("sortForExport", () => {
  it("sorts by Polish name, then by type order, without mutating the input", () => {
    const input = [note("Łódź"), note("Lublin"), note("Same"), emptyLogin("Same"), note("Zebra")];
    const copy = [...input];
    const out = sortForExport(input);
    expect(out.map((e) => `${e.name}/${e.type}`)).toEqual([
      "Lublin/note",
      "Łódź/note",
      "Same/login",
      "Same/note",
      "Zebra/note",
    ]);
    expect(input).toEqual(copy);
    expect(ENTRY_TYPE_ORDER).toEqual(["login", "contact", "card", "note", "document"]);
  });
});
