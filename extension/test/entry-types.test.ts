import { describe, expect, it } from "vitest";
import { p2p } from "@passholder/core";
import {
  emptyContent, ENTRY_TYPES, entrySummary, matchesQuery, tidyContent, TYPE_INFO, validateContent,
} from "../src/entry-types.ts";

type C = p2p.EntryContentV3;
const base = { note: "", custom: [] as p2p.CustomField[] };
const card = (over: Partial<p2p.CardFields> = {}, name = "Visa"): C => ({
  ...base, name, type: "card", fields: { holder: "", number: "", expiry: "", cvc: "", pin: "", ...over },
});
const contact = (over: Partial<p2p.ContactFields> = {}, name = "Jan"): C => ({
  ...base, name, type: "contact",
  fields: { firstName: "", lastName: "", birthDate: "", phones: [], emails: [], addresses: [], ...over },
});
const doc = (over: Partial<p2p.DocumentFields> = {}, name = "Dowód"): C => ({
  ...base, name, type: "document",
  fields: { kind: "id_card", number: "", fullName: "", issueDate: "", expiryDate: "", issuer: "", ...over },
});
const login = (over: Partial<p2p.LoginFields> = {}, name = "A"): C => ({
  ...base, name, type: "login",
  fields: { username: "", password: "pw", totp: "", urls: [], androidApps: [], ...over },
});

describe("tabs", () => {
  it("lists types in tab order", () => {
    expect(ENTRY_TYPES).toEqual(["login", "contact", "card", "note", "document"]);
    expect(TYPE_INFO.card.tab).toBe("Karty");
    expect(TYPE_INFO.login.newTitle).toBe("Nowy login");
    expect(TYPE_INFO.document.editTitle).toBe("Edytuj dokument");
  });
});

describe("entrySummary", () => {
  it("describes each type", () => {
    expect(entrySummary(card({ number: "1234 5678 9012 3456" }))).toBe("•••• 3456");
    expect(entrySummary(card({ number: "12" }))).toBe("•••• 12");
    expect(entrySummary(card())).toBe("");
    expect(entrySummary(doc({ kind: "passport" }))).toBe("Paszport");
    expect(entrySummary(contact({ phones: [{ label: "dom", value: "+48 600" }, { label: "x", value: "2" }] }))).toBe("+48 600");
    expect(entrySummary(contact())).toBe("");
    expect(entrySummary({ ...base, name: "N", type: "note", fields: {}, note: "\n\nPierwsza\nDruga" })).toBe("Pierwsza");
    expect(entrySummary(login({ username: "jan" }))).toBe("jan");
  });
});

describe("matchesQuery", () => {
  it("matches name and summary case-insensitively", () => {
    const c = card({ number: "1234 5678 9012 3456" });
    expect(matchesQuery(c, "3456")).toBe(true);
    expect(matchesQuery(c, "VISA")).toBe(true);
    expect(matchesQuery(c, "7777")).toBe(false);
    expect(matchesQuery(c, "")).toBe(true);
  });
});

describe("tidyContent", () => {
  it("drops empty list items and empty custom fields, trims only name", () => {
    const t = tidyContent(contact({ phones: [{ label: "", value: "" }, { label: "praca", value: "1" }] }, "  X "));
    expect(t.name).toBe("X");
    expect((t.fields as p2p.ContactFields).phones).toEqual([{ label: "praca", value: "1" }]);
    expect((tidyContent(login({ urls: ["", "https://a.pl"] })).fields as p2p.LoginFields).urls).toEqual(["https://a.pl"]);
    expect(tidyContent({ ...login(), custom: [{ label: "", value: "", hidden: false }] }).custom).toEqual([]);
    expect((tidyContent(login({ username: " u" })).fields as p2p.LoginFields).username).toBe(" u");
  });
});

describe("validateContent", () => {
  it("checks name, password, formats", () => {
    expect(validateContent(login({}, ""))).toBe("Podaj nazwę");
    expect(validateContent(login({ password: "" }))).toBe("Podaj albo wygeneruj hasło");
    expect(validateContent(contact({ birthDate: "2026-02-30" }))).toBe("Data urodzenia: wpisz datę RRRR-MM-DD");
    expect(validateContent(contact({ birthDate: "2028-02-29" }))).toBeUndefined();
    expect(validateContent(doc({ expiryDate: "30-01-2030" }))).toBe("Data ważności: wpisz datę RRRR-MM-DD");
    expect(validateContent(doc({ issueDate: "x" }))).toBe("Data wydania: wpisz datę RRRR-MM-DD");
    expect(validateContent(card({ expiry: "13/27" }))).toBe("Ważność: wpisz MM/RR");
    expect(validateContent(card({ expiry: "02/27" }))).toBeUndefined();
    expect(validateContent(login({ androidApps: ["com"] }))).toBe("Aplikacje Androida: zła nazwa pakietu com");
    expect(validateContent(login({ androidApps: ["com.example.app"] }))).toBeUndefined();
  });

  it("skips unchanged values from the original", () => {
    const o = doc({ expiryDate: "01.02.2030" });
    expect(validateContent(o, o)).toBeUndefined();
    expect(validateContent(doc({ expiryDate: "02.02.2030" }), o)).toBe("Data ważności: wpisz datę RRRR-MM-DD");
    expect(validateContent(card({ expiry: "2/2030" }), card({ expiry: "2/2030" }))).toBeUndefined();
    const l = login({ androidApps: ["bad"] });
    expect(validateContent(login({ androidApps: ["bad"] }), l)).toBeUndefined();
    expect(validateContent(login({ androidApps: ["bad", "x"] }), l)).toBe("Aplikacje Androida: zła nazwa pakietu x");
  });
});

describe("emptyContent", () => {
  it.each(ENTRY_TYPES)("%s passes the strict parser", (type) => {
    const c = emptyContent(type);
    expect(c.type).toBe(type);
    expect(() => p2p.parseEntryData({ ...c, v: 3, hlc: { ms: 0, c: 0, d: "x" } })).not.toThrow();
  });
  it("defaults document kind to id_card", () => {
    expect((emptyContent("document").fields as p2p.DocumentFields).kind).toBe("id_card");
  });
});
