import { PassHolderError } from "../errors.ts";
import { isRecord, type JsonObject } from "../strict-json.ts";
import {
  isDocumentKind,
  type CardFields,
  type ContactFields,
  type CustomField,
  type DocumentFields,
  type DocumentKind,
  type EntryContent,
  type LoginFields,
  type PostalAddress,
} from "../p2p/entry.ts";
import {
  addressLine,
  DOCUMENT_LABELS,
  labelled,
  SKIP_BAD_ENTRY,
  SKIP_NO_NAME,
  sortForExport,
  type ImportSkip,
  type ParsedImport,
} from "./common.ts";
import { CARD_EXPIRY } from "../field-formats.ts";

const notBitwarden = (cause?: unknown) =>
  new PassHolderError("IMPORT_NOT_BITWARDEN", "Not a Bitwarden JSON file", { cause });
const ANDROID_PREFIX = "androidapp://";

/** Bitwarden item types (`item.type`). */
const ItemType = { login: 1, secureNote: 2, card: 3, identity: 4 } as const;
type ItemType = (typeof ItemType)[keyof typeof ItemType];
const ITEM_TYPES: readonly unknown[] = Object.values(ItemType);

/** Bitwarden custom field types (`item.fields[].type`). */
const FieldType = { text: 0, hidden: 1, boolean: 2, linked: 3 } as const;

/** Labels of the custom fields that carry PassHolder fields Bitwarden has no place for. */
const LABELS = {
  documentKind: DOCUMENT_LABELS.kind,
  documentNumber: "Numer dokumentu",
  fullName: DOCUMENT_LABELS.fullName,
  issueDate: DOCUMENT_LABELS.issueDate,
  expiryDate: DOCUMENT_LABELS.expiryDate,
  issuer: DOCUMENT_LABELS.issuer,
  pin: "PIN",
} as const;

/** True for an object with an `items` array (used to detect the file kind). */
export function isBitwardenJson(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.items);
}

/** A text or number as text; null, undefined and other values become "". */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function custom(label: string, value: string, hidden = false): CustomField {
  return { label, value, hidden };
}

/** Custom fields from [label, value] pairs, without the empty ones. */
const filledCustom = (pairs: readonly (readonly [string, string])[]): CustomField[] =>
  pairs.filter(([, value]) => value !== "").map(([label, value]) => custom(label, value));

function importFields(raw: unknown): CustomField[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomField[] = [];
  for (const f of raw) {
    if (!isRecord(f)) continue;
    switch (f.type) {
      case FieldType.hidden:
        out.push(custom(text(f.name), text(f.value), true));
        break;
      case FieldType.boolean:
        out.push(custom(text(f.name), text(f.value) === "true" ? "true" : "false"));
        break;
      case FieldType.linked:
        break;
      default:
        out.push(custom(text(f.name), text(f.value)));
    }
  }
  return out;
}

/** What every item brings: its name, note and custom fields. */
interface ItemBase {
  name: string;
  note: string;
  custom: CustomField[];
}

/** An imported entry, or the Polish reason the item is skipped. */
type ItemResult = { entry: EntryContent } | { skip: string };

function importLogin(base: ItemBase, login: JsonObject): EntryContent {
  const urls: string[] = [];
  const androidApps: string[] = [];
  for (const u of Array.isArray(login.uris) ? login.uris : []) {
    const uri = isRecord(u) ? text(u.uri) : "";
    if (uri === "") continue;
    if (uri.startsWith(ANDROID_PREFIX)) androidApps.push(uri.slice(ANDROID_PREFIX.length));
    else urls.push(uri);
  }
  const fields = {
    username: text(login.username),
    password: text(login.password),
    totp: text(login.totp),
    urls,
    androidApps,
  };
  return { type: "login", ...base, fields };
}

function importCard(base: ItemBase, card: JsonObject): EntryContent {
  const rest = [...base.custom];
  const pinIdx = rest.findIndex((f) => f.label === LABELS.pin);
  const pin = pinIdx < 0 ? "" : rest.splice(pinIdx, 1)[0]!.value;
  const month = text(card.expMonth).trim();
  const year = text(card.expYear).trim();
  const fields: CardFields = {
    holder: text(card.cardholderName),
    number: text(card.number),
    expiry: month && year ? `${month.padStart(2, "0")}/${year.slice(-2)}` : "",
    cvc: text(card.code),
    pin,
  };
  const brand = text(card.brand);
  const custom = [...filledCustom([["Marka karty", brand]]), ...rest];
  return { type: "card", name: base.name, note: base.note, fields, custom };
}

function identityAddress(id: JsonObject): PostalAddress {
  return {
    label: "",
    street: [text(id.address1), text(id.address2), text(id.address3)]
      .filter((x) => x !== "")
      .join(", "),
    postalCode: text(id.postalCode),
    city: text(id.city),
    country: text(id.country),
  };
}

const hasAddress = (a: PostalAddress): boolean => Object.values(a).some((x) => x !== "");

/** Identity values PassHolder keeps as custom fields; the numbers are passed in, as a document may use one. */
function identityExtras(id: JsonObject, passport: string, license: string): [string, string][] {
  return [
    ["Tytuł", text(id.title)],
    ["Drugie imię", text(id.middleName)],
    ["Firma", text(id.company)],
    ["Numer SSN", text(id.ssn)],
    ["Numer paszportu", passport],
    ["Numer prawa jazdy", license],
    ["Nazwa użytkownika", text(id.username)],
    ["Województwo/stan", text(id.state)],
  ];
}

function importContact(base: ItemBase, id: JsonObject): EntryContent {
  const address = identityAddress(id);
  const email = text(id.email);
  const phone = text(id.phone);
  const extras = identityExtras(id, text(id.passportNumber), text(id.licenseNumber));
  return {
    type: "contact",
    name: base.name,
    note: base.note,
    custom: [...filledCustom(extras), ...base.custom],
    fields: {
      firstName: text(id.firstName),
      lastName: text(id.lastName),
      birthDate: "",
      phones: phone ? [{ label: "", value: phone }] : [],
      emails: email ? [{ label: "", value: email }] : [],
      addresses: hasAddress(address) ? [address] : [],
    },
  };
}

/** An identity whose custom field `kindField` names a document kind (as PassHolder exports documents). */
function importDocument(base: ItemBase, id: JsonObject, kindField: CustomField): EntryContent {
  const kind = kindField.value as DocumentKind;
  const passport = text(id.passportNumber);
  const license = text(id.licenseNumber);
  // A document keeps one number (the one matching its kind first); the other one goes to a custom field.
  const usesLicense =
    kind === "driving_license" ? license !== "" : passport === "" && license !== "";
  const usesPassport = !usesLicense && passport !== "";
  const address = identityAddress(id);
  const fullNameField = base.custom.find((f) => f.label === LABELS.fullName);
  const hasFullName = fullNameField !== undefined && fullNameField.value !== "";
  const extras: [string, string][] = [
    ...identityExtras(id, usesPassport ? "" : passport, usesLicense ? "" : license),
    ["E-mail", text(id.email)],
    ["Telefon", text(id.phone)],
    ["Adres", hasAddress(address) ? addressLine(address) : ""],
    ["Imię", hasFullName ? text(id.firstName) : ""],
    ["Nazwisko", hasFullName ? text(id.lastName) : ""],
  ];
  const rest = [...filledCustom(extras), ...base.custom.filter((f) => f !== kindField)];
  const take = (label: string): string => {
    const i = rest.findIndex((f) => f.label === label);
    return i < 0 ? "" : rest.splice(i, 1)[0]!.value;
  };
  const number = (usesLicense ? license : passport) || take(LABELS.documentNumber);
  const fullName =
    take(LABELS.fullName) || [text(id.firstName), text(id.lastName)].filter(Boolean).join(" ");
  const issueDate = take(LABELS.issueDate);
  const expiryDate = take(LABELS.expiryDate);
  const issuer = take(LABELS.issuer);
  return {
    type: "document",
    name: base.name,
    note: base.note,
    custom: rest,
    fields: { kind, number, fullName, issueDate, expiryDate, issuer },
  };
}

function importIdentity(base: ItemBase, id: JsonObject): EntryContent {
  const kindField = base.custom.find(
    (f) => f.label === LABELS.documentKind && isDocumentKind(f.value),
  );
  return kindField ? importDocument(base, id, kindField) : importContact(base, id);
}

const record = (value: unknown): JsonObject => (isRecord(value) ? value : {});

function importItem(item: JsonObject): ItemResult {
  if (!ITEM_TYPES.includes(item.type))
    return { skip: `typ ${text(item.type)} nie jest obsługiwany` };
  const name = text(item.name);
  if (name.trim() === "") return { skip: SKIP_NO_NAME };
  const base: ItemBase = { name, note: text(item.notes), custom: importFields(item.fields) };
  switch (item.type as ItemType) {
    case ItemType.login:
      return { entry: importLogin(base, record(item.login)) };
    case ItemType.secureNote:
      return { entry: { type: "note", ...base, fields: {} } };
    case ItemType.card:
      return { entry: importCard(base, record(item.card)) };
    case ItemType.identity:
      return { entry: importIdentity(base, record(item.identity)) };
  }
}

/** Throws code IMPORT_BITWARDEN_ENCRYPTED or IMPORT_NOT_BITWARDEN for an encrypted or unrecognised file; a bad item is skipped as "wpis N" (from 1). */
export function parseBitwardenJson(text: string): ParsedImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw notBitwarden(error);
  }
  if (isRecord(doc) && doc.encrypted === true)
    throw new PassHolderError("IMPORT_BITWARDEN_ENCRYPTED", "Encrypted Bitwarden export");
  if (!isBitwardenJson(doc)) throw notBitwarden();
  const entries: EntryContent[] = [];
  const skipped: ImportSkip[] = [];
  (doc as { items: unknown[] }).items.forEach((item, i) => {
    const result: ItemResult = isRecord(item) ? importItem(item) : { skip: SKIP_BAD_ENTRY };
    if ("skip" in result) skipped.push({ at: `wpis ${i + 1}`, reason: result.skip });
    else entries.push(result.entry);
  });
  return { entries, skipped };
}

// ---- export ----

interface BwField {
  name: string;
  value: string;
  type: number;
}

/** What one entry type adds to an item: its Bitwarden type, its body (`login`, `card`, …) and extra fields. */
interface ItemParts {
  type: ItemType;
  body: JsonObject;
  extra: BwField[];
}

/** Bitwarden writes null for an empty value. */
const orNull = (v: string): string | null => (v === "" ? null : v);
const field = (name: string, value: string, hidden = false): BwField => ({
  name,
  value,
  type: hidden ? FieldType.hidden : FieldType.text,
});
/** Fields from [label, value] pairs, without the empty ones. */
const filledFields = (pairs: readonly (readonly [string, string])[]): BwField[] =>
  pairs.filter(([, value]) => value !== "").map(([label, value]) => field(label, value));

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

function exportLogin(f: LoginFields): ItemParts {
  const uris = [
    ...f.urls.map((uri) => ({ match: null, uri })),
    ...f.androidApps.map((pkg) => ({ match: null, uri: ANDROID_PREFIX + pkg })),
  ];
  const login = {
    uris,
    username: orNull(f.username),
    password: orNull(f.password),
    totp: orNull(f.totp),
  };
  return { type: ItemType.login, body: { login }, extra: [] };
}

function exportCard(f: CardFields): ItemParts {
  const m = CARD_EXPIRY.exec(f.expiry);
  const extra: BwField[] = [];
  if (f.pin !== "") extra.push(field(LABELS.pin, f.pin, true));
  if (!m && f.expiry !== "") extra.push(field("Ważność", f.expiry));
  const card = {
    cardholderName: orNull(f.holder),
    brand: null,
    number: orNull(f.number),
    expMonth: m ? String(Number(m[1])) : null,
    expYear: m ? `20${m[2]}` : null,
    code: orNull(f.cvc),
  };
  return { type: ItemType.card, body: { card }, extra };
}

function exportContact(f: ContactFields): ItemParts {
  const [phone, ...phones] = f.phones;
  const [mail, ...mails] = f.emails;
  const [addr, ...addrs] = f.addresses;
  const extra = [
    ...phones.map((p) => field(labelled("Telefon", p.label), p.value)),
    ...mails.map((m) => field(labelled("E-mail", m.label), m.value)),
    ...addrs.map((a) => field(labelled("Adres", a.label), addressLine(a))),
    ...filledFields([["Data urodzenia", f.birthDate]]),
  ];
  const identity = {
    ...EMPTY_IDENTITY,
    firstName: orNull(f.firstName),
    lastName: orNull(f.lastName),
    phone: phone ? orNull(phone.value) : null,
    email: mail ? orNull(mail.value) : null,
    address1: addr ? orNull(addr.street) : null,
    postalCode: addr ? orNull(addr.postalCode) : null,
    city: addr ? orNull(addr.city) : null,
    country: addr ? orNull(addr.country) : null,
  };
  return { type: ItemType.identity, body: { identity }, extra };
}

/** A document is an identity: its kind and fields go to custom fields, passport and licence numbers to theirs. */
function exportDocument(f: DocumentFields): ItemParts {
  const ownNumberField = f.kind === "passport" || f.kind === "driving_license";
  const extra = [
    field(LABELS.documentKind, f.kind),
    ...filledFields([
      [LABELS.documentNumber, ownNumberField ? "" : f.number],
      [LABELS.fullName, f.fullName],
      [LABELS.issueDate, f.issueDate],
      [LABELS.expiryDate, f.expiryDate],
      [LABELS.issuer, f.issuer],
    ]),
  ];
  const identity = {
    ...EMPTY_IDENTITY,
    passportNumber: f.kind === "passport" ? orNull(f.number) : null,
    licenseNumber: f.kind === "driving_license" ? orNull(f.number) : null,
  };
  return { type: ItemType.identity, body: { identity }, extra };
}

function itemParts(e: EntryContent): ItemParts {
  switch (e.type) {
    case "login":
      return exportLogin(e.fields);
    case "note":
      return { type: ItemType.secureNote, body: { secureNote: { type: 0 } }, extra: [] };
    case "card":
      return exportCard(e.fields);
    case "contact":
      return exportContact(e.fields);
    case "document":
      return exportDocument(e.fields);
  }
}

function exportItem(e: EntryContent): JsonObject {
  const { type, body, extra } = itemParts(e);
  const fields = [...extra, ...e.custom.map((c) => field(c.label, c.value, c.hidden))];
  return { type, name: e.name, notes: orNull(e.note), favorite: false, fields, ...body };
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
