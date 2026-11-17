import type { CardFields, CustomField, DocumentKind, EntryContent } from "../p2p/entry.ts";
import {
  addressLine,
  labelled,
  sortForExport,
  type ImportSkip,
  type ParsedImport,
} from "./common.ts";

const NOT_BITWARDEN = "To nie jest plik Bitwarden JSON";
const ENCRYPTED =
  "Zaszyfrowany eksport Bitwarden nie jest obsługiwany. Wyeksportuj z Bitwardena plik JSON bez szyfrowania.";
const ANDROID_PREFIX = "androidapp://";
const DOCUMENT_KINDS: readonly string[] = [
  "id_card",
  "passport",
  "driving_license",
  "student_id",
  "other",
];

const L_KIND = "Rodzaj dokumentu";
const L_NUMBER = "Numer dokumentu";
const L_FULL_NAME = "Imię i nazwisko";
const L_ISSUE = "Data wydania";
const L_EXPIRY = "Data ważności";
const L_ISSUER = "Wystawca";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an object with an `items` array (used to detect the file kind). */
export function isBitwardenJson(value: unknown): boolean {
  return isObj(value) && Array.isArray(value.items);
}

/** null, undefined and non-text values become "". */
function s(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function custom(label: string, value: string, hidden = false): CustomField {
  return { label, value, hidden };
}

function importFields(raw: unknown): CustomField[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomField[] = [];
  for (const f of raw) {
    if (!isObj(f)) continue;
    switch (f.type) {
      case 1:
        out.push(custom(s(f.name), s(f.value), true));
        break;
      case 2:
        out.push(custom(s(f.name), s(f.value) === "true" ? "true" : "false"));
        break;
      case 3:
        break;
      default:
        out.push(custom(s(f.name), s(f.value)));
    }
  }
  return out;
}

const L_PIN = "PIN";

function importCard(c: Obj, pin: string): CardFields {
  const month = s(c.expMonth).trim();
  const year = s(c.expYear).trim();
  return {
    holder: s(c.cardholderName),
    number: s(c.number),
    expiry: month && year ? `${month.padStart(2, "0")}/${year.slice(-2)}` : "",
    cvc: s(c.code),
    pin,
  };
}

function importIdentity(name: string, note: string, id: Obj, fields: CustomField[]): EntryContent {
  const kindIdx = fields.findIndex((f) => f.label === L_KIND && DOCUMENT_KINDS.includes(f.value));
  const isDocument = kindIdx >= 0;
  const address = {
    label: "",
    street: [s(id.address1), s(id.address2), s(id.address3)].filter((x) => x !== "").join(", "),
    postalCode: s(id.postalCode),
    city: s(id.city),
    country: s(id.country),
  };
  const hasAddress = Object.values(address).some((x) => x !== "");
  const passport = s(id.passportNumber);
  const license = s(id.licenseNumber);
  const fullNameField = fields.find((f) => f.label === L_FULL_NAME);
  const hasFullName = fullNameField !== undefined && fullNameField.value !== "";
  // A document keeps one number (the one matching its kind first); the other one goes to a custom field.
  const kind = isDocument ? (fields[kindIdx]!.value as DocumentKind) : undefined;
  const usesLicense =
    kind === "driving_license" ? license !== "" : passport === "" && license !== "";
  const usesPassport = !usesLicense && passport !== "";
  const numberFromIdentity = usesLicense ? license : passport;
  const extras: [string, string][] = [
    ["Tytuł", s(id.title)],
    ["Drugie imię", s(id.middleName)],
    ["Firma", s(id.company)],
    ["Numer SSN", s(id.ssn)],
    ["Numer paszportu", isDocument && usesPassport ? "" : passport],
    ["Numer prawa jazdy", isDocument && usesLicense ? "" : license],
    ["Nazwa użytkownika", s(id.username)],
    ["Województwo/stan", s(id.state)],
    ...(isDocument
      ? ([
          ["E-mail", s(id.email)],
          ["Telefon", s(id.phone)],
          ["Adres", hasAddress ? addressLine(address) : ""],
          ["Imię", hasFullName ? s(id.firstName) : ""],
          ["Nazwisko", hasFullName ? s(id.lastName) : ""],
        ] as [string, string][])
      : []),
  ];
  const all = [...extras.filter(([, v]) => v !== "").map(([l, v]) => custom(l, v)), ...fields];

  if (isDocument) {
    all.splice(
      all.findIndex((f) => f === fields[kindIdx]),
      1,
    );
    const take = (label: string): string => {
      const i = all.findIndex((f) => f.label === label);
      return i < 0 ? "" : all.splice(i, 1)[0]!.value;
    };
    const number = numberFromIdentity || take(L_NUMBER);
    const fullName =
      take(L_FULL_NAME) || [s(id.firstName), s(id.lastName)].filter(Boolean).join(" ");
    return {
      type: "document",
      name,
      note,
      custom: all,
      fields: {
        kind: kind!,
        number,
        fullName,
        issueDate: take(L_ISSUE),
        expiryDate: take(L_EXPIRY),
        issuer: take(L_ISSUER),
      },
    };
  }

  const email = s(id.email);
  const phone = s(id.phone);
  return {
    type: "contact",
    name,
    note,
    custom: all,
    fields: {
      firstName: s(id.firstName),
      lastName: s(id.lastName),
      birthDate: "",
      phones: phone ? [{ label: "", value: phone }] : [],
      emails: email ? [{ label: "", value: email }] : [],
      addresses: hasAddress ? [address] : [],
    },
  };
}

function importItem(item: Obj): EntryContent | string {
  if (![1, 2, 3, 4].includes(item.type as number))
    return `typ ${s(item.type)} nie jest obsługiwany`;
  const name = s(item.name);
  if (name.trim() === "") return "brak nazwy";
  const note = s(item.notes);
  const fields = importFields(item.fields);
  switch (item.type) {
    case 1: {
      const login = isObj(item.login) ? item.login : {};
      const urls: string[] = [];
      const androidApps: string[] = [];
      for (const u of Array.isArray(login.uris) ? login.uris : []) {
        const uri = isObj(u) ? s(u.uri) : "";
        if (uri === "") continue;
        if (uri.startsWith(ANDROID_PREFIX)) androidApps.push(uri.slice(ANDROID_PREFIX.length));
        else urls.push(uri);
      }
      return {
        type: "login",
        name,
        note,
        custom: fields,
        fields: {
          username: s(login.username),
          password: s(login.password),
          totp: s(login.totp),
          urls,
          androidApps,
        },
      };
    }
    case 2:
      return { type: "note", name, note, fields: {}, custom: fields };
    case 3: {
      const card = isObj(item.card) ? item.card : {};
      const brand = s(card.brand);
      const pinIdx = fields.findIndex((f) => f.label === L_PIN);
      const pin = pinIdx < 0 ? "" : fields.splice(pinIdx, 1)[0]!.value;
      return {
        type: "card",
        name,
        note,
        fields: importCard(card, pin),
        custom: [...(brand ? [custom("Marka karty", brand)] : []), ...fields],
      };
    }
    default:
      return importIdentity(name, note, isObj(item.identity) ? item.identity : {}, fields);
  }
}

/** Throws a Polish message for an encrypted or unrecognised file; a bad item is skipped as "wpis N" (from 1). */
export function parseBitwardenJson(text: string): ParsedImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(NOT_BITWARDEN);
  }
  if (isObj(doc) && doc.encrypted === true) throw new Error(ENCRYPTED);
  if (!isBitwardenJson(doc)) throw new Error(NOT_BITWARDEN);
  const entries: EntryContent[] = [];
  const skipped: ImportSkip[] = [];
  (doc as { items: unknown[] }).items.forEach((item, i) => {
    const r = isObj(item) ? importItem(item) : "zły format wpisu";
    if (typeof r === "string") skipped.push({ at: `wpis ${i + 1}`, reason: r });
    else entries.push(r);
  });
  return { entries, skipped };
}

// ---- export ----

interface BwField {
  name: string;
  value: string;
  type: number;
}

const nn = (v: string): string | null => (v === "" ? null : v);
const field = (name: string, value: string, hidden = false): BwField => ({
  name,
  value,
  type: hidden ? 1 : 0,
});

const EMPTY_IDENTITY = {
  title: null,
  firstName: null,
  middleName: null,
  lastName: null,
  address1: null,
  address2: null,
  address3: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  company: null,
  email: null,
  phone: null,
  ssn: null,
  username: null,
  passportNumber: null,
  licenseNumber: null,
};

function exportItem(e: EntryContent): Obj {
  const extra: BwField[] = [];
  let body: Obj;
  let type: number;
  switch (e.type) {
    case "login": {
      const f = e.fields;
      type = 1;
      body = {
        login: {
          uris: [
            ...f.urls.map((uri) => ({ match: null, uri })),
            ...f.androidApps.map((pkg) => ({ match: null, uri: ANDROID_PREFIX + pkg })),
          ],
          username: nn(f.username),
          password: nn(f.password),
          totp: nn(f.totp),
        },
      };
      break;
    }
    case "note":
      type = 2;
      body = { secureNote: { type: 0 } };
      break;
    case "card": {
      const f = e.fields;
      const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(f.expiry);
      type = 3;
      if (f.pin !== "") extra.push(field(L_PIN, f.pin, true));
      if (!m && f.expiry !== "") extra.push(field("Ważność", f.expiry));
      body = {
        card: {
          cardholderName: nn(f.holder),
          brand: null,
          number: nn(f.number),
          expMonth: m ? String(Number(m[1])) : null,
          expYear: m ? `20${m[2]}` : null,
          code: nn(f.cvc),
        },
      };
      break;
    }
    case "contact": {
      const f = e.fields;
      const [phone, ...phones] = f.phones;
      const [mail, ...mails] = f.emails;
      const [addr, ...addrs] = f.addresses;
      type = 4;
      extra.push(
        ...phones.map((p) => field(labelled("Telefon", p.label), p.value)),
        ...mails.map((m) => field(labelled("E-mail", m.label), m.value)),
        ...addrs.map((a) => field(labelled("Adres", a.label), addressLine(a))),
      );
      if (f.birthDate !== "") extra.push(field("Data urodzenia", f.birthDate));
      body = {
        identity: {
          ...EMPTY_IDENTITY,
          firstName: nn(f.firstName),
          lastName: nn(f.lastName),
          phone: phone ? nn(phone.value) : null,
          email: mail ? nn(mail.value) : null,
          address1: addr ? nn(addr.street) : null,
          postalCode: addr ? nn(addr.postalCode) : null,
          city: addr ? nn(addr.city) : null,
          country: addr ? nn(addr.country) : null,
        },
      };
      break;
    }
    case "document": {
      const f = e.fields;
      type = 4;
      extra.push(field(L_KIND, f.kind));
      if (f.kind !== "passport" && f.kind !== "driving_license" && f.number !== "")
        extra.push(field(L_NUMBER, f.number));
      const rest: [string, string][] = [
        [L_FULL_NAME, f.fullName],
        [L_ISSUE, f.issueDate],
        [L_EXPIRY, f.expiryDate],
        [L_ISSUER, f.issuer],
      ];
      for (const [label, value] of rest) {
        if (value !== "") extra.push(field(label, value));
      }
      body = {
        identity: {
          ...EMPTY_IDENTITY,
          passportNumber: f.kind === "passport" ? nn(f.number) : null,
          licenseNumber: f.kind === "driving_license" ? nn(f.number) : null,
        },
      };
      break;
    }
  }
  const fields = [...extra, ...e.custom.map((c) => field(c.label, c.value, c.hidden))];
  return { type, name: e.name, notes: nn(e.note), favorite: false, fields, ...body };
}

export function exportBitwardenJson(entries: readonly EntryContent[]): string {
  return (
    JSON.stringify(
      { encrypted: false, folders: [], items: sortForExport(entries).map(exportItem) },
      null,
      2,
    ) + "\n"
  );
}
