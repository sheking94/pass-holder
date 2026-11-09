import type { CustomField, DocumentKind, EntryContentV3 } from "../p2p/entry.ts";
import { parseCsv, toCsv } from "./csv.ts";
import { addressLine, labelled, sortForExport, type ImportSkip, type ParsedImport } from "./common.ts";

/** NordPass export header, in its order. Import finds columns by name, so the order there does not matter. */
export const NORDPASS_COLUMNS = [
  "name", "url", "username", "password", "note", "cardholdername", "cardnumber", "cvc", "expirydate", "zipcode",
  "folder", "full_name", "phone_number", "email", "address1", "address2", "city", "country", "state", "totp",
  "shared_folder",
] as const;

type Column = (typeof NORDPASS_COLUMNS)[number] | "type";

/** Polish names of document kinds, as in the extension (its DOCUMENT_KIND_LABELS is not shared). */
const DOCUMENT_KIND_NAMES: Record<DocumentKind, string> = {
  id_card: "Dowód osobisty",
  passport: "Paszport",
  driving_license: "Prawo jazdy",
  student_id: "Legitymacja",
  other: "Inny",
};

const EMPTY_FILE = "Plik jest pusty";
const NOT_NORDPASS = "To nie wygląda na eksport z NordPass: brak kolumn name/url w pierwszym wierszu";
const TYPES: Record<string, "login" | "note" | "card" | "contact"> = {
  password: "login", note: "note", credit_card: "card", identity: "contact",
};
/** Columns that do not make a row more than a note when guessing the type. */
const NOTE_COLUMNS: readonly Column[] = ["name", "note", "folder", "shared_folder", "type"];

/** Host of a URL without "www.", or the text itself if it is not a URL. Used when a row has no name. */
function nameFromUrl(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const extra = (label: string, value: string): CustomField => ({ label, value, hidden: false });
const filled = (v: string): boolean => v.trim() !== "";

/** Throws a Polish message for an empty or unrecognised file; a row that cannot be taken is skipped as "wiersz N" (header is 1). */
export function parseNordPassCsv(text: string): ParsedImport {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error(EMPTY_FILE);
  const index = new Map(header.fields.map((name, i) => [name.trim().toLowerCase(), i]));
  if (!index.has("name") && !index.has("url")) throw new Error(NOT_NORDPASS);

  const entries: EntryContentV3[] = [];
  const skipped: ImportSkip[] = [];
  for (const { line, fields } of rows) {
    const get = (column: Column): string => {
      const i = index.get(column);
      return i === undefined ? "" : (fields[i] ?? "");
    };
    const at = `wiersz ${line}`;

    let kind: "login" | "note" | "card" | "contact";
    const declared = get("type").trim();
    if (declared !== "") {
      const key = declared.toLowerCase();
      const known = Object.hasOwn(TYPES, key) ? TYPES[key] : undefined;
      if (!known) {
        skipped.push({ at, reason: `typ „${declared}” nie jest obsługiwany` });
        continue;
      }
      kind = known;
    } else if (filled(get("cardnumber"))) {
      kind = "card";
    } else if ((["full_name", "phone_number", "email", "address1"] as const).some((c) => filled(get(c)))) {
      kind = "contact";
    } else if ([...index.keys()].every((c) => NOTE_COLUMNS.includes(c as Column) || !filled(get(c as Column)))) {
      kind = "note";
    } else {
      kind = "login";
    }

    const url = get("url").trim();
    const name = get("name").trim() || (url ? nameFromUrl(url) : "");
    if (name === "") {
      skipped.push({ at, reason: "brak nazwy i adresu" });
      continue;
    }
    const note = get("note");

    switch (kind) {
      case "login":
        entries.push({
          type: "login", name, note, custom: [],
          fields: { username: get("username"), password: get("password"), totp: get("totp"), urls: url ? [url] : [], androidApps: [] },
        });
        break;
      case "note":
        entries.push({ type: "note", name, note, fields: {}, custom: [] });
        break;
      case "card":
        entries.push({
          type: "card", name, note,
          fields: { holder: get("cardholdername"), number: get("cardnumber"), expiry: get("expirydate"), cvc: get("cvc"), pin: "" },
          custom: filled(get("zipcode")) ? [extra("Kod pocztowy", get("zipcode"))] : [],
        });
        break;
      case "contact": {
        const fullName = get("full_name").trim();
        const space = fullName.indexOf(" ");
        const street = [get("address1"), get("address2")].filter(filled).join(", ");
        const address = { label: "", street, postalCode: get("zipcode"), city: get("city"), country: get("country") };
        const hasAddress = ["address1", "address2", "zipcode", "city", "country"].some((c) => filled(get(c as Column)));
        entries.push({
          type: "contact", name, note,
          fields: {
            firstName: space < 0 ? fullName : fullName.slice(0, space),
            lastName: space < 0 ? "" : fullName.slice(space + 1).trim(),
            birthDate: "",
            phones: filled(get("phone_number")) ? [{ label: "", value: get("phone_number") }] : [],
            emails: filled(get("email")) ? [{ label: "", value: get("email") }] : [],
            addresses: hasAddress ? [address] : [],
          },
          custom: filled(get("state")) ? [extra("Województwo/stan", get("state"))] : [],
        });
        break;
      }
      default:
        // Unreachable while kind is one of the four; a row must never vanish silently.
        skipped.push({ at, reason: "nieznany typ wpisu" });
    }
  }
  return { entries, skipped };
}

// ---- export ----

const line = (label: string, value: string): string[] => (value === "" ? [] : [`${label}: ${value}`]);

function exportRow(e: EntryContentV3): string[] {
  const v: Partial<Record<Column, string>> = { name: e.name };
  let lines: string[] = [];
  switch (e.type) {
    case "login": {
      const f = e.fields;
      Object.assign(v, { url: f.urls[0] ?? "", username: f.username, password: f.password, totp: f.totp });
      lines = [...f.urls.slice(1).flatMap((u) => line("Adres strony", u)), ...f.androidApps.flatMap((a) => line("Aplikacja Androida", a))];
      break;
    }
    case "card": {
      const f = e.fields;
      Object.assign(v, { cardholdername: f.holder, cardnumber: f.number, cvc: f.cvc, expirydate: f.expiry });
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
      if (addr) Object.assign(v, { address1: addr.street, zipcode: addr.postalCode, city: addr.city, country: addr.country });
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
        ...line("Rodzaj dokumentu", DOCUMENT_KIND_NAMES[f.kind] ?? ""), ...line("Numer", f.number),
        ...line("Imię i nazwisko", f.fullName), ...line("Data wydania", f.issueDate),
        ...line("Data ważności", f.expiryDate), ...line("Wystawca", f.issuer),
      ];
      break;
    }
  }
  lines.push(...e.custom.flatMap((c) => line(c.label, c.value)));
  v.note = [...(e.note === "" ? [] : [e.note]), ...lines].join("\n");
  return NORDPASS_COLUMNS.map((c) => v[c] ?? "");
}

export function exportNordPassCsv(entries: readonly EntryContentV3[]): string {
  return toCsv([NORDPASS_COLUMNS, ...sortForExport(entries).map(exportRow)]);
}
