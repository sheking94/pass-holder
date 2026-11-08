import { describe, expect, it } from "vitest";
import { newVaultKey } from "../../src/vault.ts";
import {
  emptyLogin,
  encryptPayloadV2,
  entryBlobLength,
  MAX_ENTRY_BLOB_LENGTH,
  parseEntryData,
  parseTombstoneData,
  serializeEntryData,
  type EntryDataV3,
} from "../../src/p2p/index.ts";

const hlc = { ms: 5, c: 1, d: "dev" };
const base = { v: 3 as const, name: "n", note: "x", custom: [{ label: "l", value: "v", hidden: true }], hlc };

const samples: EntryDataV3[] = [
  { ...base, type: "login", fields: { username: "u", password: "p", totp: "t", urls: ["https://a"], androidApps: ["pkg"] } },
  {
    ...base,
    type: "contact",
    fields: {
      firstName: "A", lastName: "B", birthDate: "1990-01-02",
      phones: [{ label: "home", value: "1" }], emails: [{ label: "w", value: "a@b" }],
      addresses: [{ label: "h", street: "s", postalCode: "p", city: "c", country: "PL" }],
    },
  },
  { ...base, type: "card", fields: { holder: "h", number: "1", expiry: "01/30", cvc: "123", pin: "0000" } },
  { ...base, type: "note", fields: {} },
  {
    ...base,
    type: "document",
    fields: { kind: "passport", number: "n", fullName: "f", issueDate: "a", expiryDate: "b", issuer: "i" },
  },
];

const login = () => structuredClone(samples[0]) as any;
const contact = () => structuredClone(samples[1]) as any;
const mutate = (make: () => any, f: (x: any) => void) => () => {
  const x = make();
  f(x);
  return x;
};

describe("entry v3", () => {
  it("parses every type", () => {
    for (const x of samples) expect(parseEntryData(JSON.parse(serializeEntryData(x)))).toEqual(x);
  });

  it("reads v2 payload as login", () => {
    expect(parseEntryData({ name: "a", username: "u", password: "p", hlc })).toEqual({
      v: 3, type: "login", name: "a", note: "",
      fields: { username: "u", password: "p", totp: "", urls: [], androidApps: [] },
      custom: [], hlc,
    });
  });

  const rejects: [string, () => unknown][] = [
    ["unknown type", mutate(login, (x) => { x.type = "wifi"; })],
    ["v 2", mutate(login, (x) => { x.v = 2; })],
    ["v string", mutate(login, (x) => { x.v = "3"; })],
    ["v fractional", mutate(login, (x) => { x.v = 3.5; })],
    ["missing totp", mutate(login, (x) => { delete x.fields.totp; })],
    ["urls number", mutate(login, (x) => { x.fields.urls = [1]; })],
    ["hidden string", mutate(login, (x) => { x.custom[0].hidden = "true"; })],
    ["extra top key", mutate(login, (x) => { x.extra = 1; })],
    ["extra fields key", mutate(login, (x) => { x.fields.extra = 1; })],
    ["extra custom key", mutate(login, (x) => { x.custom[0].extra = 1; })],
    ["extra address key", mutate(contact, (x) => { x.fields.addresses[0].extra = 1; })],
    ["note with fields", mutate(() => structuredClone(samples[3]), (x) => { x.fields = { x: "" }; })],
    ["bad document kind", mutate(() => structuredClone(samples[4]), (x) => { x.fields.kind = "visa"; })],
    ["v2 extra deleted", () => ({ name: "a", username: "u", password: "p", hlc, deleted: true })],
    ["hlc extra key", mutate(login, (x) => { x.hlc.extra = 1; })],
    ["hlc missing key", mutate(login, (x) => { delete x.hlc.d; x.hlc.z = 1; })],
    ["v2 hlc extra key", () => ({ name: "a", username: "u", password: "p", hlc: { ...hlc, extra: 1 } })],
    ["v2 no password", () => ({ name: "a", username: "u", hlc })],
  ];
  it.each(rejects)("rejects %s", (_n, make) => {
    expect(() => parseEntryData(make())).toThrow("Invalid entry payload");
  });

  it("does not check date formats", () => {
    const c = contact();
    c.fields.birthDate = "1.2.1990";
    expect(parseEntryData(c).type).toBe("contact");
    const k = structuredClone(samples[2]) as any;
    k.fields.expiry = "2027-01";
    expect(parseEntryData(k).type).toBe("card");
  });

  it("strict tombstone", () => {
    expect(parseTombstoneData({ hlc })).toEqual({ hlc });
    expect(() => parseTombstoneData({ hlc, name: "x" })).toThrow("Invalid tombstone payload");
    expect(() => parseTombstoneData({ hlc, deleted: true })).toThrow("Invalid tombstone payload");
    expect(() => parseTombstoneData({ hlc: { ...hlc, extra: 1 } })).toThrow("Invalid tombstone payload");
  });

  it("serializes in fixed key order", () => {
    const reversed = {
      hlc: { d: "dev", c: 1, ms: 5 },
      custom: [],
      fields: { androidApps: ["a"], urls: ["u"], totp: "t", password: "p", username: "n" },
      note: "x", name: "nm", type: "login", v: 3,
    } as unknown as EntryDataV3;
    expect(serializeEntryData(reversed)).toBe(
      '{"v":3,"type":"login","name":"nm","note":"x","fields":{"username":"n","password":"p","totp":"t","urls":["u"],"androidApps":["a"]},"custom":[],"hlc":{"ms":5,"c":1,"d":"dev"}}',
    );
  });

  it("serializes a tombstone as {hlc}", () => {
    expect(serializeEntryData({ hlc })).toBe('{"hlc":{"ms":5,"c":1,"d":"dev"}}');
  });

  it("blob length matches encryption", async () => {
    const d: EntryDataV3 = { ...base, type: "note", note: "ż🙂".repeat(1000), fields: {} };
    expect(entryBlobLength(d)).toBe((await encryptPayloadV2(newVaultKey(), "id", d)).length);
  });

  it("65536 boundary counts UTF-8 bytes", () => {
    const withNote = (note: string): EntryDataV3 => ({ ...base, type: "note", note, custom: [], fields: {} });
    const jsonBytes = (note: string) => new TextEncoder().encode(serializeEntryData(withNote(note))).length;
    // 65536 Base64 chars = 49152 raw bytes = 29 bytes of framing + 49123 bytes of JSON
    const zs = "ż".repeat(1000);
    const note = zs + "a".repeat(49123 - jsonBytes(zs));
    expect(jsonBytes(note)).toBe(49123);
    expect(entryBlobLength(withNote(note))).toBe(MAX_ENTRY_BLOB_LENGTH);
    expect(entryBlobLength(withNote(note + "ż"))).toBeGreaterThan(MAX_ENTRY_BLOB_LENGTH);
  });

  it("emptyLogin", () => {
    expect(emptyLogin("x")).toEqual({
      type: "login", name: "x", note: "", custom: [],
      fields: { username: "", password: "", totp: "", urls: [], androidApps: [] },
    });
    expect(emptyLogin().name).toBe("");
  });
});
