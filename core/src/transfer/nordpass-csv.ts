import { PassHolderError } from "../errors.ts";
import type { ContactFields, CustomField, EntryContent } from "../p2p/entry.ts";
import { hostOf } from "../web-address.ts";
import { parseCsv, toCsv } from "./csv.ts";
import {
  addressLine,
  DOCUMENT_KIND_NAMES,
  DOCUMENT_LABELS,
  labelled,
  sortForExport,
  type ImportSkip,
  type ParsedImport,
} from "./common.ts";

/** NordPass export header, in its order. Import finds columns by name, so the order there does not matter. */
export const NORDPASS_COLUMNS = [
  "name",
  "url",
  "username",
  "password",
  "note",
  "cardholdername",
  "cardnumber",
  "cvc",
  "expirydate",
  "zipcode",
  "folder",
  "full_name",
  "phone_number",
  "email",
  "address1",
  "address2",
  "city",
  "country",
  "state",
  "totp",
  "shared_folder",
] as const;

type Column = (typeof NORDPASS_COLUMNS)[number] | "type";
type Kind = "login" | "note" | "card" | "contact";
/** One CSV row: the text of a column, "" when the file has no such column. */
type Row = (column: Column) => string;

const TYPES: Record<string, Kind> = {
  password: "login",
  note: "note",
  credit_card: "card",
  identity: "contact",
};
/** Columns that do not make a row more than a note when guessing the type. */
const NOTE_COLUMNS: readonly Column[] = ["name", "note", "folder", "shared_folder", "type"];
const CONTACT_COLUMNS = ["full_name", "phone_number", "email", "address1"] as const;
const ADDRESS_COLUMNS = ["address1", "address2", "zipcode", "city", "country"] as const;

/** Host of a URL (see hostOf), or the text itself if it has none. Used when a row has no name. */
const nameFromUrl = (url: string): string => hostOf(url) ?? url;

const extra = (label: string, value: string): CustomField => ({ label, value, hidden: false });
const filled = (v: string): boolean => v.trim() !== "";

/**
 * The entry type of a row: the declared "type" column, else guessed from the filled columns (`columns`: all
 * columns of the file); a skip reason for a declared type PassHolder does not know.
 */
function guessKind(row: Row, columns: readonly string[]): { kind: Kind } | { skip: string } {
  const declared = row("type").trim();
  if (declared !== "") {
    const key = declared.toLowerCase();
    return Object.hasOwn(TYPES, key)
      ? { kind: TYPES[key]! }
      : { skip: `typ „${declared}” nie jest obsługiwany` };
  }
  if (filled(row("cardnumber"))) return { kind: "card" };
  if (CONTACT_COLUMNS.some((c) => filled(row(c)))) return { kind: "contact" };
  const onlyNoteColumns = columns.every(
    (c) => NOTE_COLUMNS.includes(c as Column) || !filled(row(c as Column)),
  );
  return { kind: onlyNoteColumns ? "note" : "login" };
}

function contactFields(row: Row): ContactFields {
  const fullName = row("full_name").trim();
  const space = fullName.indexOf(" ");
  const hasAddress = ADDRESS_COLUMNS.some((c) => filled(row(c)));
  const address = {
    label: "",
    street: [row("address1"), row("address2")].filter(filled).join(", "),
    postalCode: row("zipcode"),
    city: row("city"),
    country: row("country"),
  };
  return {
    firstName: space < 0 ? fullName : fullName.slice(0, space),
    lastName: space < 0 ? "" : fullName.slice(space + 1).trim(),
    birthDate: "",
    phones: filled(row("phone_number")) ? [{ label: "", value: row("phone_number") }] : [],
    emails: filled(row("email")) ? [{ label: "", value: row("email") }] : [],
    addresses: hasAddress ? [address] : [],
  };
}

/** The entry of a row of the given kind, named `name`. */
function rowToEntry(row: Row, kind: Kind, name: string): EntryContent {
  const note = row("note");
  switch (kind) {
    case "login": {
      const url = row("url").trim();
      const fields = {
        username: row("username"),
        password: row("password"),
        totp: row("totp"),
        urls: url ? [url] : [],
        androidApps: [],
      };
      return { type: "login", name, note, custom: [], fields };
    }
    case "note":
      return { type: "note", name, note, fields: {}, custom: [] };
    case "card": {
      const fields = {
        holder: row("cardholdername"),
        number: row("cardnumber"),
        expiry: row("expirydate"),
        cvc: row("cvc"),
        pin: "",
      };
      const custom = filled(row("zipcode")) ? [extra("Kod pocztowy", row("zipcode"))] : [];
      return { type: "card", name, note, fields, custom };
    }
    case "contact": {
      const custom = filled(row("state")) ? [extra("Województwo/stan", row("state"))] : [];
      return { type: "contact", name, note, fields: contactFields(row), custom };
    }
  }
}

/** Throws code IMPORT_EMPTY_FILE or IMPORT_NOT_NORDPASS for an empty or unrecognised file; a row that cannot be taken is skipped as "wiersz N" (header is 1). */
export function parseNordPassCsv(text: string): ParsedImport {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new PassHolderError("IMPORT_EMPTY_FILE", "The file is empty");
  const index = new Map(header.fields.map((name, i) => [name.trim().toLowerCase(), i]));
  if (!index.has("name") && !index.has("url"))
    throw new PassHolderError("IMPORT_NOT_NORDPASS", "No name/url columns in the first row");
  const columns = [...index.keys()];

  const entries: EntryContent[] = [];
  const skipped: ImportSkip[] = [];
  for (const { line, fields } of rows) {
    const row: Row = (column) => {
      const i = index.get(column);
      return i === undefined ? "" : (fields[i] ?? "");
    };
    const at = `wiersz ${line}`;
    const guess = guessKind(row, columns);
    if ("skip" in guess) {
      skipped.push({ at, reason: guess.skip });
      continue;
    }
    const url = row("url").trim();
    const name = row("name").trim() || (url ? nameFromUrl(url) : "");
    if (name === "") {
      skipped.push({ at, reason: "brak nazwy i adresu" });
      continue;
    }
    entries.push(rowToEntry(row, guess.kind, name));
  }
  return { entries, skipped };
}

// ---- export ----

const line = (label: string, value: string): string[] =>
  value === "" ? [] : [`${label}: ${value}`];

function exportRow(e: EntryContent): string[] {
  const v: Partial<Record<Column, string>> = { name: e.name };
  let lines: string[] = [];
  switch (e.type) {
    case "login": {
      const f = e.fields;
      Object.assign(v, {
        url: f.urls[0] ?? "",
        username: f.username,
        password: f.password,
        totp: f.totp,
      });
      lines = [
        ...f.urls.slice(1).flatMap((u) => line("Adres strony", u)),
        ...f.androidApps.flatMap((a) => line("Aplikacja Androida", a)),
      ];
      break;
    }
    case "card": {
      const f = e.fields;
      Object.assign(v, {
        cardholdername: f.holder,
        cardnumber: f.number,
        cvc: f.cvc,
        expirydate: f.expiry,
      });
      lines = line("PIN", f.pin);
      break;
    }
    case "contact": {
      const f = e.fields;
      const [phone, ...phones] = f.phones;
      const [mail, ...mails] = f.emails;
      const [addr, ...addrs] = f.addresses;
      v.full_name = `${f.firstName} ${f.lastName}`.trim();
      v.phone_number = phone?.value ?? "";
      v.email = mail?.value ?? "";
      if (addr)
        Object.assign(v, {
          address1: addr.street,
          zipcode: addr.postalCode,
          city: addr.city,
          country: addr.country,
        });
      lines = [
        ...phones.flatMap((p) => line(labelled("Telefon", p.label), p.value)),
        ...mails.flatMap((m) => line(labelled("E-mail", m.label), m.value)),
        ...addrs.flatMap((a) => line(labelled("Adres", a.label), addressLine(a))),
        ...line("Data urodzenia", f.birthDate),
      ];
      break;
    }
    case "note":
      break;
    case "document": {
      const f = e.fields;
      lines = [
        ...line(DOCUMENT_LABELS.kind, DOCUMENT_KIND_NAMES[f.kind] ?? ""),
        ...line("Numer", f.number),
        ...line(DOCUMENT_LABELS.fullName, f.fullName),
        ...line(DOCUMENT_LABELS.issueDate, f.issueDate),
        ...line(DOCUMENT_LABELS.expiryDate, f.expiryDate),
        ...line(DOCUMENT_LABELS.issuer, f.issuer),
      ];
      break;
    }
  }
  lines.push(...e.custom.flatMap((c) => line(c.label, c.value)));
  v.note = [...(e.note === "" ? [] : [e.note]), ...lines].join("\n");
  return NORDPASS_COLUMNS.map((c) => v[c] ?? "");
}

export function exportNordPassCsv(entries: readonly EntryContent[]): string {
  return toCsv([NORDPASS_COLUMNS, ...sortForExport(entries).map(exportRow)]);
}
