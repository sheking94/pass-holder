import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  exportNordPassCsv, NORDPASS_COLUMNS, parseCsv, parseNordPassCsv, sortForExport, type ParsedImport,
} from "../../src/transfer/index.ts";
import type { EntryContentV3 } from "../../src/p2p/entry.ts";

const read = (name: string) => readFileSync(new URL(`../../test-vectors/transfer/${name}`, import.meta.url), "utf8");
const HEADER = "name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,totp,shared_folder";

const login: EntryContentV3 = {
  type: "login", name: "Poczta", note: "notatka", custom: [],
  fields: { username: "jan", password: 'p,"a"\nss', totp: "JBSWY3DPEHPK3PXP", urls: ["https://example.com"], androidApps: [] },
};
const card: EntryContentV3 = {
  type: "card", name: "Karta", note: "", custom: [],
  fields: { holder: "Jan Testowy", number: "4111111111111111", expiry: "12/30", cvc: "123", pin: "" },
};
const contact: EntryContentV3 = {
  type: "contact", name: "Jan", note: "", custom: [],
  fields: {
    firstName: "Jan", lastName: "Maria Testowy", birthDate: "",
    phones: [{ label: "", value: "500100200" }], emails: [{ label: "", value: "jan@example.com" }],
    addresses: [{ label: "", street: "ul. Przykładowa 1", postalCode: "00-001", city: "Warszawa", country: "Polska" }],
  },
};
const note: EntryContentV3 = { type: "note", name: "Notatka", note: "tekst", fields: {}, custom: [] };

function exportedRow(entry: EntryContentV3): Record<string, string> {
  const rows = parseCsv(exportNordPassCsv([entry]));
  return Object.fromEntries(NORDPASS_COLUMNS.map((c, i) => [c, rows[1]!.fields[i]!]));
}

describe("parseNordPassCsv sample files", () => {
  for (const name of ["nordpass", "nordpass-typed"]) {
    it(`${name}.csv matches its expected file`, () => {
      expect(parseNordPassCsv(read(`${name}.csv`))).toEqual(JSON.parse(read(`${name}.expected.json`)) as ParsedImport);
    });
  }

  it("covers every importable type and the skips", () => {
    const plain = parseNordPassCsv(read("nordpass.csv"));
    expect(plain.entries.map((e) => e.type)).toEqual(["login", "login", "card", "contact", "note", "login", "login"]);
    expect(plain.skipped).toEqual([{ at: "wiersz 7", reason: "brak nazwy i adresu" }]);
    const typed = parseNordPassCsv(read("nordpass-typed.csv"));
    expect(typed.entries.map((e) => e.type)).toEqual(["login", "note", "card", "contact", "login"]);
    expect(typed.skipped).toEqual([{ at: "wiersz 6", reason: "typ „folder” nie jest obsługiwany" }]);
  });
});

describe("parseNordPassCsv", () => {
  it("rejects an empty file and one that is not a NordPass export", () => {
    expect(() => parseNordPassCsv("")).toThrow("Plik jest pusty");
    expect(() => parseNordPassCsv("foo,bar\n1,2")).toThrow(
      "To nie wygląda na eksport z NordPass: brak kolumn name/url w pierwszym wierszu",
    );
  });

  it("accepts the header only", () => {
    expect(parseNordPassCsv(HEADER + "\n")).toEqual({ entries: [], skipped: [] });
  });

  it("does not throw on a row shorter than the header and treats missing columns as empty", () => {
    const r = parseNordPassCsv(`${HEADER}\nKrótki,https://example.com\n`);
    expect(r.skipped).toEqual([]);
    expect(r.entries[0]).toMatchObject({ type: "login", name: "Krótki", fields: { urls: ["https://example.com"], username: "", password: "" } });
  });

  it("finds columns by name in any order, ignoring case and spaces", () => {
    const r = parseNordPassCsv(" Password ,NAME,Username\ns1,Poczta,jan\n");
    expect(r.entries[0]).toMatchObject({ name: "Poczta", fields: { username: "jan", password: "s1" } });
  });

  it("names a row by the host of its URL, without www.", () => {
    const r = parseNordPassCsv("name,url\n,https://www.example.com/login\n,example.org/x\n,\n");
    expect(r.entries.map((e) => e.name)).toEqual(["example.com", "example.org"]);
    expect(r.skipped).toEqual([{ at: "wiersz 4", reason: "brak nazwy i adresu" }]);
  });

  it("uses the type column over guessing, and guesses without it", () => {
    const r = parseNordPassCsv("type,name,cardnumber,note\npassword,A,4111,\n,B,4111,\nnote,C,,tekst\n");
    expect(r.entries.map((e) => e.type)).toEqual(["login", "card", "note"]);
  });

  it("reads the type column case-insensitively", () => {
    const r = parseNordPassCsv("type,name,username\nPassword,A,jan\nNOTE,B,\n");
    expect(r.entries.map((e) => e.type)).toEqual(["login", "note"]);
  });

  it("skips a type that is an Object.prototype name instead of losing the row", () => {
    const r = parseNordPassCsv("type,name\nconstructor,A\n__proto__,B\ntoString,C\n");
    expect(r.entries).toEqual([]);
    expect(r.skipped).toEqual([
      { at: "wiersz 2", reason: "typ „constructor” nie jest obsługiwany" },
      { at: "wiersz 3", reason: "typ „__proto__” nie jest obsługiwany" },
      { at: "wiersz 4", reason: "typ „toString” nie jest obsługiwany" },
    ]);
  });

  it("ignores a whitespace-only phone and e-mail of a contact", () => {
    const r = parseNordPassCsv("name,full_name,phone_number,email\nC,Jan Testowy,  ,\t\n");
    expect(r.entries[0]).toMatchObject({ type: "contact", fields: { phones: [], emails: [] } });
  });

  it("keeps a login without a password and the card expiry as written", () => {
    const r = parseNordPassCsv("name,username,cardnumber,expirydate\nA,jan,,\nB,,4111,2030-12\n");
    expect(r.entries[0]).toMatchObject({ type: "login", fields: { password: "" } });
    expect(r.entries[1]).toMatchObject({ type: "card", fields: { expiry: "2030-12" } });
  });

  it("puts the card zip code and the contact state into custom fields", () => {
    const r = parseNordPassCsv("name,cardnumber,zipcode,full_name,state\nK,4111,00-001,,\nC,,,Jan Testowy,mazowieckie\n");
    expect(r.entries[0]!.custom).toEqual([{ label: "Kod pocztowy", value: "00-001", hidden: false }]);
    expect(r.entries[1]!.custom).toEqual([{ label: "Województwo/stan", value: "mazowieckie", hidden: false }]);
  });
});

describe("exportNordPassCsv", () => {
  it("writes exactly the NordPass header and one row per entry, sorted", () => {
    const rows = parseCsv(exportNordPassCsv([note, login]));
    expect(rows[0]!.fields.join(",")).toBe(HEADER);
    expect(rows.map((r) => r.fields[0])).toEqual(["name", "Notatka", "Poczta"]);
    expect(rows.every((r) => r.fields.length === 21)).toBe(true);
  });

  it("round-trips a login, card without PIN, contact and note", () => {
    const entries = [login, card, contact, note];
    expect(parseNordPassCsv(exportNordPassCsv(entries))).toEqual({ entries: sortForExport(entries), skipped: [] });
  });

  it("writes a document as a note with lines in a fixed order", () => {
    const doc: EntryContentV3 = {
      type: "document", name: "Paszport", note: "uwaga", custom: [{ label: "Sekret", value: "x", hidden: true }],
      fields: { kind: "passport", number: "AB123", fullName: "Jan Testowy", issueDate: "2020-01-01", expiryDate: "2030-01-01", issuer: "Wojewoda" },
    };
    expect(exportedRow(doc).note).toBe(
      "uwaga\nRodzaj dokumentu: Paszport\nNumer: AB123\nImię i nazwisko: Jan Testowy\nData wydania: 2020-01-01\nData ważności: 2030-01-01\nWystawca: Wojewoda\nSekret: x",
    );
    const bare: EntryContentV3 = { ...doc, note: "", custom: [], fields: { ...doc.fields, kind: "id_card", number: "", fullName: "", issueDate: "", expiryDate: "", issuer: "" } };
    expect(exportedRow(bare).note).toBe("Rodzaj dokumentu: Dowód osobisty");
  });

  it("appends the extras of a login, card and contact to the note", () => {
    const l = { ...login, note: "", custom: [{ label: "Pytanie", value: "Kolor?", hidden: false }],
      fields: { ...login.fields, urls: ["https://a.example.com", "https://b.example.com"], androidApps: ["com.example.app"] } } as EntryContentV3;
    expect(exportedRow(l).url).toBe("https://a.example.com");
    expect(exportedRow(l).note).toBe("Adres strony: https://b.example.com\nAplikacja Androida: com.example.app\nPytanie: Kolor?");
    expect(exportedRow({ ...card, fields: { ...card.fields, pin: "1234" } } as EntryContentV3).note).toBe("PIN: 1234");
    const base = contact.type === "contact" ? contact.fields : undefined!;
    const c: EntryContentV3 = { ...contact, note: "n", fields: { ...base, birthDate: "1990-01-02",
      phones: [...base.phones, { label: "dom", value: "600" }, { label: "", value: "700" }],
      emails: [...base.emails, { label: "praca", value: "p@example.com" }],
      addresses: [...base.addresses, { label: "biuro", street: "Długa 2", postalCode: "", city: "Gdańsk", country: "" }] } };
    const row = exportedRow(c);
    expect(row).toMatchObject({ full_name: "Jan Maria Testowy", phone_number: "500100200", email: "jan@example.com", address1: "ul. Przykładowa 1", zipcode: "00-001", city: "Warszawa", country: "Polska" });
    expect(row.note).toBe("n\nTelefon (dom): 600\nTelefon: 700\nE-mail (praca): p@example.com\nAdres (biuro): Długa 2, Gdańsk\nData urodzenia: 1990-01-02");
  });
});
