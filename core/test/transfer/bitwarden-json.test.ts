import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEntryContent, type DocumentKind, type EntryContentV3 } from "../../src/p2p/entry.ts";
import {
  exportBitwardenJson,
  isBitwardenJson,
  parseBitwardenJson,
  sortForExport,
  type ParsedImport,
} from "../../src/transfer/index.ts";

const read = (name: string) =>
  readFileSync(new URL(`../../test-vectors/transfer/${name}`, import.meta.url), "utf8");
const file = read("bitwarden.json");
const expected = JSON.parse(read("bitwarden.expected.json")) as ParsedImport;

const doc = (kind: DocumentKind, number: string): EntryContentV3 => ({
  type: "document",
  name: `Dokument ${kind}`,
  note: "n",
  fields: {
    kind,
    number,
    fullName: "Jan Testowy",
    issueDate: "2020-01-01",
    expiryDate: "2030-01-01",
    issuer: "Urząd",
  },
  custom: [{ label: "Własne", value: "x", hidden: true }],
});

const roundTrip = (entries: EntryContentV3[]) => parseBitwardenJson(exportBitwardenJson(entries));

describe("parseBitwardenJson", () => {
  it("matches the shared sample file", () => {
    expect(parseBitwardenJson(file)).toEqual(expected);
  });

  it("produces valid v3 entries", () => {
    for (const e of expected.entries) expect(parseEntryContent(e)).toEqual(e);
  });

  it("rejects an encrypted export", () => {
    const msg =
      "Zaszyfrowany eksport Bitwarden nie jest obsługiwany. Wyeksportuj z Bitwardena plik JSON bez szyfrowania.";
    expect(() => parseBitwardenJson(JSON.stringify({ encrypted: true, data: "x" }))).toThrow(msg);
  });

  it("rejects other files", () => {
    expect(() => parseBitwardenJson("nie json")).toThrow("To nie jest plik Bitwarden JSON");
    expect(() => parseBitwardenJson("[]")).toThrow("To nie jest plik Bitwarden JSON");
    expect(() => parseBitwardenJson('{"items":{}}')).toThrow("To nie jest plik Bitwarden JSON");
  });
});

describe("exportBitwardenJson", () => {
  it("round-trips every document kind", () => {
    const entries = [
      doc("id_card", "ABC1"),
      doc("passport", "EA1"),
      doc("driving_license", "DL1"),
      doc("student_id", "S1"),
      doc("other", "O1"),
    ];
    expect(roundTrip(entries)).toEqual({ entries: sortForExport(entries), skipped: [] });
  });

  it("round-trips a card with its PIN (the PIN is not left as a custom field)", () => {
    const card: EntryContentV3 = {
      type: "card",
      name: "K",
      note: "",
      custom: [{ label: "Własne", value: "x", hidden: false }],
      fields: { holder: "Jan Testowy", number: "4111", expiry: "03/27", cvc: "123", pin: "9876" },
    };
    expect(roundTrip([card])).toEqual({ entries: [card], skipped: [] });
  });

  it("round-trips a note", () => {
    const note: EntryContentV3 = {
      type: "note",
      name: "N",
      note: "tekst",
      fields: {},
      custom: [{ label: "a", value: "b", hidden: false }],
    };
    const text = exportBitwardenJson([note]);
    expect(JSON.parse(text).items[0]).toMatchObject({
      type: 2,
      secureNote: { type: 0 },
      notes: "tekst",
    });
    expect(parseBitwardenJson(text).entries).toEqual([note]);
  });

  it("round-trips a login with urls, android apps, totp and custom fields", () => {
    const login: EntryContentV3 = {
      type: "login",
      name: "L",
      note: "",
      custom: [
        { label: "p", value: "v", hidden: false },
        { label: "q", value: "w", hidden: true },
      ],
      fields: {
        username: "u",
        password: "p",
        totp: "T",
        urls: ["https://example.com"],
        androidApps: ["com.example.app"],
      },
    };
    const text = exportBitwardenJson([login]);
    const item = JSON.parse(text).items[0];
    expect(item.notes).toBeNull();
    expect(item.login.uris).toEqual([
      { match: null, uri: "https://example.com" },
      { match: null, uri: "androidapp://com.example.app" },
    ]);
    expect(parseBitwardenJson(text)).toEqual({ entries: [login], skipped: [] });
  });

  it("exports a card expiry as month and year, and the PIN as a hidden field", () => {
    const card: EntryContentV3 = {
      type: "card",
      name: "K",
      note: "",
      custom: [],
      fields: { holder: "Jan Testowy", number: "4111", expiry: "03/27", cvc: "123", pin: "9876" },
    };
    const item = JSON.parse(exportBitwardenJson([card])).items[0];
    expect(item.type).toBe(3);
    expect(item.card).toMatchObject({ expMonth: "3", expYear: "2027", brand: null, code: "123" });
    expect(item.fields).toEqual([{ name: "PIN", value: "9876", type: 1 }]);
    const odd = JSON.parse(
      exportBitwardenJson([
        { ...card, fields: { ...card.fields, expiry: "marzec 2027", pin: "" } },
      ]),
    ).items[0];
    expect(odd.card).toMatchObject({ expMonth: null, expYear: null });
    expect(odd.fields).toEqual([{ name: "Ważność", value: "marzec 2027", type: 0 }]);
  });

  it("exports a contact into identity fields and extra labelled fields", () => {
    const contact: EntryContentV3 = {
      type: "contact",
      name: "C",
      note: "",
      custom: [],
      fields: {
        firstName: "Jan",
        lastName: "Testowy",
        birthDate: "1990-01-01",
        phones: [
          { label: "dom", value: "1" },
          { label: "praca", value: "2" },
          { label: "", value: "3" },
        ],
        emails: [
          { label: "", value: "a@example.com" },
          { label: "biuro", value: "b@example.com" },
        ],
        addresses: [
          {
            label: "dom",
            street: "ul. A 1",
            postalCode: "00-001",
            city: "Warszawa",
            country: "PL",
          },
          { label: "", street: "ul. B 2", postalCode: "", city: "Kraków", country: "" },
        ],
      },
    };
    const item = JSON.parse(exportBitwardenJson([contact])).items[0];
    expect(item.identity).toMatchObject({
      firstName: "Jan",
      lastName: "Testowy",
      phone: "1",
      email: "a@example.com",
      address1: "ul. A 1",
      postalCode: "00-001",
      city: "Warszawa",
      country: "PL",
    });
    expect(item.fields).toEqual([
      { name: "Telefon (praca)", value: "2", type: 0 },
      { name: "Telefon", value: "3", type: 0 },
      { name: "E-mail (biuro)", value: "b@example.com", type: 0 },
      { name: "Adres", value: "ul. B 2, Kraków", type: 0 },
      { name: "Data urodzenia", value: "1990-01-01", type: 0 },
    ]);
  });

  it("writes the document kind field and puts passport and licence numbers in identity", () => {
    const items = JSON.parse(
      exportBitwardenJson([
        doc("passport", "EA1"),
        doc("driving_license", "DL1"),
        doc("id_card", "ID1"),
      ]),
    ).items;
    const byName = (n: string) => items.find((i: { name: string }) => i.name === n);
    expect(byName("Dokument passport").identity).toMatchObject({
      passportNumber: "EA1",
      licenseNumber: null,
      firstName: null,
    });
    expect(byName("Dokument driving_license").identity.licenseNumber).toBe("DL1");
    expect(byName("Dokument id_card").fields[0]).toEqual({
      name: "Rodzaj dokumentu",
      value: "id_card",
      type: 0,
    });
    expect(byName("Dokument id_card").fields[1]).toEqual({
      name: "Numer dokumentu",
      value: "ID1",
      type: 0,
    });
  });

  it("starts with the unencrypted envelope", () => {
    const parsed = JSON.parse(exportBitwardenJson([]));
    expect(parsed).toEqual({ encrypted: false, folders: [], items: [] });
    expect(isBitwardenJson(parsed)).toBe(true);
  });
});

describe("isBitwardenJson", () => {
  it("recognises an object with an items array", () => {
    expect(isBitwardenJson(JSON.parse(file))).toBe(true);
    expect(isBitwardenJson({ format: "passholder", entries: [] })).toBe(false);
    expect(isBitwardenJson([])).toBe(false);
    expect(isBitwardenJson(null)).toBe(false);
  });
});
